import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ShortsCleanupDatabaseService } from './shorts-cleanup-database.service';
import type { ShortsScope } from './shorts-metadata.service';

/** Internal storage coordination only; no provider credentials or removal authority. */
@Injectable()
export class ShortsPrivateReferenceBarriersService {
  constructor(
    @Inject(ShortsCleanupDatabaseService) private readonly db: DataSource,
  ) {}

  private scope(scope: ShortsScope) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract)
    )
      throw new Error('Invalid cleanup scope');
    return [scope.network, scope.contract];
  }

  private uuid(id: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        id,
      )
    )
      throw new Error('Invalid cleanup operation');
    return id;
  }

  private transaction<T>(work: (db: EntityManager) => Promise<T>) {
    return this.db.transaction('READ COMMITTED', async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      return work(db);
    });
  }

  /** Explicit permanent opt-in: old writers must now bind new opaque manifests. */
  async enrol(scope: ShortsScope) {
    const args = this.scope(scope);
    await this.transaction(async (db) => {
      await db.query('SELECT shorts_private_barrier_lock($1,$2)', args);
      await db.query(
        `INSERT INTO shorts_private_cleanup_scopes(network,contract)
        SELECT $1::varchar,$2::varchar WHERE NOT EXISTS(SELECT FROM shorts_private_cleanup_scopes WHERE network=$1 AND contract=$2)`,
        args,
      );
    });
  }

  async get(scope: ShortsScope, id: string) {
    const [row] = await this.db.query(
      'SELECT * FROM shorts_private_input_barriers WHERE network=$1 AND contract=$2 AND id=$3',
      [...this.scope(scope), this.uuid(id)],
    );
    return row;
  }

  async reserve(scope: ShortsScope, id: string, scan: string, key: string) {
    const args = [...this.scope(scope), this.uuid(id), this.uuid(scan), key];
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_/-]{1,512}$/.test(key))
      throw new Error('Invalid private object key');
    return this.transaction(async (db) => {
      // Acquire canonical/epoch locks before an idempotency check or unique-key wait.
      await db.query('SELECT shorts_private_barrier_proof($1,$2,$3,$4)', [
        args[0],
        args[1],
        args[3],
        args[4],
      ]);
      const [existing] = await db.query(
        'SELECT * FROM shorts_private_input_barriers WHERE id=$1',
        [id],
      );
      if (existing) {
        if (
          existing.network !== scope.network ||
          existing.contract !== scope.contract ||
          existing.object_key !== key
        )
          throw new ConflictException('Cleanup operation was already used');
        return existing;
      }
      const [row] = await db.query(
        `INSERT INTO shorts_private_input_barriers(id,network,contract,scan_id,object_key)
        VALUES($3,$1,$2,$4,$5) RETURNING *`,
        args,
      );
      return row;
    });
  }

  /** A sealed barrier is permanent, including after crashes or uncertain removal. */
  async seal(scope: ShortsScope, id: string, scan: string) {
    const args = [...this.scope(scope), this.uuid(id), this.uuid(scan)];
    return this.transaction(async (db) => {
      const [saved] = await db.query(
        'SELECT * FROM shorts_private_input_barriers WHERE network=$1 AND contract=$2 AND id=$3',
        args.slice(0, 3),
      );
      if (!saved) throw new ConflictException('Cleanup barrier is missing');
      if (saved.state === 'sealed') return saved;
      await db.query('SELECT shorts_private_barrier_proof($1,$2,$3,$4)', [
        scope.network,
        scope.contract,
        scan,
        saved.object_key,
      ]);
      const [row] = await db.query(
        `WITH changed AS (UPDATE shorts_private_input_barriers SET state='sealed',seal_scan_id=$4
        WHERE network=$1 AND contract=$2 AND id=$3 AND state='reserved' RETURNING *) SELECT * FROM changed`,
        args,
      );
      if (!row) {
        const [concurrent] = await db.query(
          'SELECT * FROM shorts_private_input_barriers WHERE network=$1 AND contract=$2 AND id=$3',
          args.slice(0, 3),
        );
        if (concurrent?.state === 'sealed') return concurrent;
        throw new ConflictException('Cleanup barrier is no longer reserved');
      }
      return row;
    });
  }

  async cancel(scope: ShortsScope, id: string) {
    const args = [...this.scope(scope), this.uuid(id)];
    return this.transaction(async (db) => {
      await db.query(
        'SELECT shorts_private_barrier_lock($1,$2)',
        args.slice(0, 2),
      );
      const [saved] = await db.query(
        'SELECT * FROM shorts_private_input_barriers WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        args,
      );
      if (saved?.state === 'cancelled') return saved;
      if (saved?.state !== 'reserved')
        throw new ConflictException(
          'Only an unsealed barrier can be cancelled',
        );
      const [row] = await db.query(
        `WITH changed AS (UPDATE shorts_private_input_barriers SET state='cancelled'
        WHERE network=$1 AND contract=$2 AND id=$3 RETURNING *) SELECT * FROM changed`,
        args,
      );
      return row;
    });
  }
}
