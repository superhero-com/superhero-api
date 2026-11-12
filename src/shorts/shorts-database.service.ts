import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { IsolationLevel } from 'typeorm/driver/types/IsolationLevel';

export const SHORTS_DATABASE_LIMITS = Symbol('SHORTS_DATABASE_LIMITS');
export interface ShortsDatabaseLimits {
  concurrency: number;
  connectMs: number;
  statementMs: number;
  lockMs: number;
  operationMs: number;
}
function integer(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Invalid ${name}`);
  return value;
}
export function shortsDatabaseLimits(): ShortsDatabaseLimits {
  return {
    concurrency: integer('SHORTS_DB_CONCURRENCY', 4, 1, 16),
    connectMs: 1000,
    statementMs: 15000,
    lockMs: 5000,
    operationMs: 25000,
  };
}
interface PgClient {
  end(): Promise<void>;
  connection: { stream: { destroy(): void } };
}
interface Operation {
  cancel(): void;
  done?: Promise<unknown>;
}

/** A separate pool for Shorts SQL, preserving TypeORM transaction identity. */
@Injectable()
export class ShortsDatabaseService
  extends DataSource
  implements OnModuleInit, OnModuleDestroy
{
  private readonly limits: ShortsDatabaseLimits;
  private readonly active = new Set<Operation>();
  private readonly admitted = new Set<QueryRunner>();
  private stopped = false;

  constructor(
    @Inject(DataSource) source: DataSource,
    @Optional() @Inject(SHORTS_DATABASE_LIMITS) limits = shortsDatabaseLimits(),
  ) {
    if (source.options.type !== 'postgres' || source.options.replication)
      throw new Error('Shorts requires a primary PostgreSQL connection');
    super({
      ...source.options,
      name: 'shorts-workloads',
      entities: [],
      subscribers: [],
      migrations: [],
      migrationsRun: false,
      synchronize: false,
      dropSchema: false,
      logging: false,
      poolSize: limits.concurrency,
      extra: {
        ...source.options.extra,
        max: limits.concurrency,
        min: 0,
        connectionTimeoutMillis: limits.connectMs,
        statement_timeout: limits.statementMs,
        lock_timeout: limits.lockMs,
        idle_in_transaction_session_timeout: limits.statementMs,
        // A client query_timeout rejects without cancelling server work. The
        // operation watchdog below closes the socket instead of reusing it.
        query_timeout: false,
        application_name: 'superhero-shorts',
      },
    });
    this.limits = limits;
  }
  async onModuleInit() {
    await this.initialize();
  }

  override query<T = any>(
    sql: string,
    parameters?: any[],
    runner?: QueryRunner,
  ): Promise<T> {
    if (runner) {
      if (!this.admitted.has(runner) || runner.isReleased)
        return Promise.reject(
          new ServiceUnavailableException('Shorts database operation ended'),
        );
      return super.query(sql, parameters, runner);
    }
    return this.run('READ COMMITTED', (manager) =>
      manager.query(sql, parameters),
    );
  }

  override transaction<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T>;
  override transaction<T>(
    isolation: IsolationLevel,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T>;
  override transaction<T>(
    isolation: IsolationLevel | ((manager: EntityManager) => Promise<T>),
    work?: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return typeof isolation === 'function'
      ? this.run('READ COMMITTED', isolation)
      : this.run(isolation, work!);
  }

  private run<T>(
    isolation: IsolationLevel,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    if (
      this.stopped ||
      !this.isInitialized ||
      this.active.size >= this.limits.concurrency
    )
      return Promise.reject(
        new ServiceUnavailableException(
          'Shorts database is busy; retry shortly',
        ),
      );
    const runner = this.createQueryRunner();
    let expired = false;
    let client: PgClient | undefined;
    let closing: Promise<void> | undefined;
    const close = () => {
      if (!client || closing) return;
      // Destroy the actual transport before returning capacity. A Promise
      // timeout by itself would leave the query/transaction running in PostgreSQL.
      client.connection.stream.destroy();
      closing = client.end().catch(() => {});
    };
    let rejectDeadline: (reason: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const operation: Operation = {
      cancel: () => {
        if (expired) return;
        expired = true;
        this.admitted.delete(runner);
        close();
        rejectDeadline(
          new ServiceUnavailableException(
            'Shorts database operation interrupted; check saved state before retrying',
          ),
        );
      },
    };
    this.active.add(operation);
    this.admitted.add(runner);
    const timer = setTimeout(operation.cancel, this.limits.operationMs);
    timer.unref();
    const connecting = runner.connect().catch(() => {
      throw new ServiceUnavailableException(
        'Shorts database connection unavailable',
      );
    });
    const execute = async () => {
      client = await connecting;
      if (expired) {
        close();
        throw new ServiceUnavailableException();
      }
      if (typeof client.connection?.stream?.destroy !== 'function')
        throw new Error('Unsupported PostgreSQL transport');
      try {
        await runner.startTransaction(isolation);
        // Ensure inherited role/connection options cannot disable SQL deadlines.
        await runner.query(
          "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true),set_config('idle_in_transaction_session_timeout',$1,true),set_config('client_connection_check_interval','1000',true)",
          [String(this.limits.statementMs), String(this.limits.lockMs)],
        );
        const value = await work(runner.manager);
        if (expired || this.stopped) throw new ServiceUnavailableException();
        await runner.commitTransaction();
        return value;
      } catch (error) {
        if (runner.isTransactionActive && !runner.isReleased && !expired)
          await runner.rollbackTransaction().catch(() => {
            close();
          });
        throw error;
      }
    };
    // Promise.race observes late failures too. A timed-out callback retains a
    // released manager and cannot issue another SQL command or commit later.
    operation.done = Promise.race([execute(), deadline])
      .catch((error) => {
        if (error?.code === 'SH509')
          throw new ServiceUnavailableException(
            'Upload storage capacity reached. Existing uploads are saved.',
          );
        if (['57014', '55P03', '25P03', '08006', '57P01'].includes(error?.code))
          throw new ServiceUnavailableException(
            'Shorts database temporarily unavailable; check saved state before retrying',
          );
        throw error;
      })
      .finally(async () => {
        clearTimeout(timer);
        this.admitted.delete(runner);
        // A connect timeout is handled by pg-pool; it never transfers ownership
        // to this operation. Active connections are drained or destroyed first.
        try {
          // Shutdown can arrive during pool acquisition. Wait for the bounded
          // acquisition before releasing, including a connection arriving late.
          await connecting.catch(() => {});
          if (expired) close();
          if (closing) await closing;
          await runner.release();
        } finally {
          this.active.delete(operation);
        }
      });
    return operation.done as Promise<T>;
  }

  async onModuleDestroy() {
    this.stopped = true;
    const pending = [...this.active];
    for (const operation of pending) operation.cancel();
    await Promise.allSettled(pending.map((operation) => operation.done));
    if (this.isInitialized) await this.destroy();
  }
}
