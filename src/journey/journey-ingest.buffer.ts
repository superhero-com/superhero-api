import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JourneyEvent } from './entities/journey-event.entity';
import { JOURNEY_LIMITS } from './journey.constants';
import { JourneyEventRow } from './journey-payload';

/**
 * In-memory write buffer between the ingest endpoint and Postgres.
 *
 * The endpoint only ever calls `push()`, which is synchronous, so a request
 * never waits on the database. Rows are written in bulk every few seconds or
 * as soon as enough are waiting. This is best-effort analytics: when the
 * buffer is full new rows are dropped, and a failed insert drops its batch
 * (logged once, without the payload) instead of retrying.
 */
@Injectable()
export class JourneyIngestBuffer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JourneyIngestBuffer.name);
  private rows: JourneyEventRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private failing = false;
  private dropped = 0;

  constructor(
    @InjectRepository(JourneyEvent)
    private readonly repository: Repository<JourneyEvent>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, JOURNEY_LIMITS.FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** Rows waiting to be written. */
  get size(): number {
    return this.rows.length;
  }

  /** Rows dropped because the buffer was full or an insert failed. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Queue rows for the next flush. Never throws, never awaits. */
  push(rows: JourneyEventRow[]): void {
    if (!rows.length) {
      return;
    }
    const room = JOURNEY_LIMITS.MAX_BUFFERED_ROWS - this.rows.length;
    if (room <= 0) {
      this.dropped += rows.length;
      return;
    }
    const accepted = rows.length > room ? rows.slice(0, room) : rows;
    this.dropped += rows.length - accepted.length;
    for (const row of accepted) {
      this.rows.push(row);
    }
    // An in-flight flush keeps draining until the buffer is empty, so only
    // start one when none is running.
    if (this.rows.length >= JOURNEY_LIMITS.FLUSH_AT_ROWS && !this.flushing) {
      void this.flush();
    }
  }

  /**
   * Write everything buffered so far. A call that arrives while a flush is in
   * flight waits for it and then writes whatever is still left, so
   * `onModuleDestroy` never returns with rows behind.
   */
  flush(): Promise<void> {
    if (this.flushing) {
      return this.flushing.then(() => this.flush());
    }
    if (!this.rows.length) {
      return Promise.resolve();
    }
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.rows.length) {
      const batch = this.rows.splice(0, JOURNEY_LIMITS.MAX_ROWS_PER_INSERT);
      try {
        await this.repository
          .createQueryBuilder()
          .insert()
          .into(JourneyEvent)
          .values(batch)
          .updateEntity(false)
          .execute();
        this.failing = false;
      } catch (error) {
        this.dropped += batch.length;
        // Logged once per failure streak, and only the error code: a driver
        // message can quote row values, and none of them belong in a log.
        if (!this.failing) {
          this.failing = true;
          const code = (error as { code?: string })?.code ?? 'unknown';
          this.logger.warn(
            `Journey event insert failed (code ${code}); dropping ${batch.length} rows`,
          );
        }
      }
    }
  }
}
