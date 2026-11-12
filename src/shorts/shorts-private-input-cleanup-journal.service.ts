import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { ShortsCleanupDatabaseService } from './shorts-cleanup-database.service';
import type { ShortsScope } from './shorts-metadata.service';
import type { PrivateObjectRef } from './shorts-private-objects.service';
import type { ShortRecord } from './shorts.types';
import { privateCleanupVerifications } from './shorts-private-cleanup-batch';

export interface PrivateCleanupSnapshot {
  operationId: string;
  barrierId: string;
  scope: ShortsScope;
  ref: PrivateObjectRef;
  version: string;
  storageId: string;
  sourceHash: string;
  epoch: string;
  observedAt: string;
  stateHash: string;
  records: {
    shortId: string;
    sourceKey: string;
    resourceId: string;
    rootHash: string;
    durabilityHash: string;
    record: ShortRecord;
  }[];
}
export type PrivateCleanupProofSnapshot = Pick<
  PrivateCleanupSnapshot,
  'operationId' | 'scope' | 'stateHash' | 'observedAt'
>;

/** SQL permissions separate verification from deletion; no provider I/O here. */
@Injectable()
export class ShortsPrivateInputCleanupJournalService {
  constructor(
    @Inject(ShortsCleanupDatabaseService) private readonly db: DataSource,
  ) {}

  private uuid(id: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        id,
      )
    )
      throw new Error('Invalid private cleanup identity');
    return id;
  }
  private args(scope: ShortsScope, id: string) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract)
    )
      throw new Error('Invalid private cleanup scope');
    return [scope.network, scope.contract, this.uuid(id)];
  }
  private transaction<T>(work: (db: EntityManager) => Promise<T>) {
    return this.db.transaction('READ COMMITTED', async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      return work(db);
    });
  }
  private async operation(
    db: DataSource | EntityManager,
    scope: ShortsScope,
    id: string,
  ) {
    const [op] = await db.query(
      `SELECT o.*,b.object_key,b.key_id,b.sha256,b.bytes,b.storage_id,b.source_hash,
      EXISTS(SELECT FROM shorts_private_input_attempts a JOIN shorts_private_input_outcomes e ON e.attempt_id=a.id
        WHERE a.operation_id=o.id AND e.kind='removed') AS removed
      FROM shorts_private_input_cleanup o JOIN shorts_private_input_barriers b ON b.id=o.barrier_id
      WHERE o.network=$1 AND o.contract=$2 AND o.id=$3`,
      this.args(scope, id),
    );
    return op;
  }
  async get(scope: ShortsScope, id: string) {
    const operation = await this.operation(this.db, scope, id);
    if (!operation) return null;
    const recent = await this.db.query(
      'SELECT * FROM shorts_private_input_attempts WHERE operation_id=$1 ORDER BY issued_at DESC,id DESC LIMIT 65',
      [id],
    );
    const attempts = recent.slice(0, 64).reverse();
    const outcomes = await this.db.query(
      `SELECT e.* FROM shorts_private_input_outcomes e JOIN shorts_private_input_attempts a ON a.id=e.attempt_id
      WHERE a.operation_id=$1 AND a.id=ANY($2::uuid[]) ORDER BY e.observed_at,e.id`,
      [id, attempts.map((attempt) => attempt.id)],
    );
    return {
      operation,
      attempts,
      outcomes,
      historyTruncated: recent.length > 64,
    };
  }
  async reserve(
    scope: ShortsScope,
    id: string,
    barrier: string,
    inventory: string,
    identity: string,
  ) {
    this.args(scope, id);
    this.uuid(barrier);
    this.uuid(inventory);
    if (!/^[a-f0-9]{64}$/.test(identity))
      throw new Error('Invalid private inventory identity');
    return this.transaction(async (db) => {
      const [binding] = await db.query(
        'SELECT network,contract FROM shorts_private_input_barriers WHERE id=$1',
        [barrier],
      );
      if (
        !binding ||
        binding.network !== scope.network ||
        binding.contract !== scope.contract
      )
        throw new NotFoundException();
      await db.query('SELECT shorts_private_sealed_snapshot($1)', [barrier]);
      const existing = await this.operation(db, scope, id);
      if (existing) {
        if (
          existing.barrier_id !== barrier ||
          existing.identity !== identity ||
          existing.inventory_id !== inventory
        )
          throw new ConflictException(
            'Private cleanup identity was already used',
          );
        return existing;
      }
      await db.query(
        `INSERT INTO shorts_private_input_cleanup(id,barrier_id,inventory_id,identity) VALUES($1,$2,$3,$4)`,
        [id, barrier, inventory, identity],
      );
      return this.operation(db, scope, id);
    });
  }
  async snapshot(
    scope: ShortsScope,
    id: string,
  ): Promise<PrivateCleanupSnapshot> {
    return this.transaction(async (db) => {
      if (!(await this.operation(db, scope, id))) throw new NotFoundException();
      const [{ snapshot }] = await db.query(
        'SELECT shorts_private_cleanup_snapshot($1) AS snapshot',
        [id],
      );
      return snapshot;
    });
  }
  /** Only the API verifier role can append this proof, after actual byte/pin reads. */
  async verified(
    scope: ShortsScope,
    id: string,
    verification: string,
    snapshot: PrivateCleanupProofSnapshot,
  ) {
    this.uuid(verification);
    if (
      snapshot.operationId !== id ||
      snapshot.scope.network !== scope.network ||
      snapshot.scope.contract !== scope.contract ||
      !/^[a-f0-9]{64}$/.test(snapshot.stateHash) ||
      !Number.isFinite(Date.parse(snapshot.observedAt))
    )
      throw new Error('Invalid private durability snapshot');
    return this.transaction(async (db) => {
      if (!(await this.operation(db, scope, id))) throw new NotFoundException();
      const [row] = await db.query(
        `INSERT INTO shorts_private_input_verifications(id,operation_id,state_hash,started_at)
        VALUES($1,$2,$3,$4) RETURNING id,operation_id,verified_at,expires_at`,
        [verification, id, snapshot.stateHash, snapshot.observedAt],
      );
      return row;
    });
  }
  /** Commit one bounded verification run atomically, with a shared database expiry. */
  async verifiedBatch(
    scope: ShortsScope,
    proofs: { verificationId: string; snapshot: PrivateCleanupProofSnapshot }[],
  ) {
    const requests = privateCleanupVerifications(
      proofs.map(({ verificationId, snapshot }) => ({
        operationId: snapshot.operationId,
        verificationId,
      })),
    );
    for (const { snapshot } of proofs) {
      this.args(scope, snapshot.operationId);
      if (
        snapshot.scope.network !== scope.network ||
        snapshot.scope.contract !== scope.contract ||
        !/^[a-f0-9]{64}$/.test(snapshot.stateHash) ||
        !Number.isFinite(Date.parse(snapshot.observedAt))
      )
        throw new Error('Invalid private durability snapshot');
    }
    return this.transaction(async (db) => {
      await db.query(
        'SELECT shorts_private_cleanup_lock_batch($1,$2,$3::uuid[])',
        [scope.network, scope.contract, requests.map((row) => row.operationId)],
      );
      const values: string[] = [],
        args: string[] = [];
      for (const { verificationId, snapshot } of proofs) {
        const offset = args.length;
        args.push(
          verificationId,
          snapshot.operationId,
          snapshot.stateHash,
          snapshot.observedAt,
        );
        values.push(
          `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4})`,
        );
      }
      return db.query(
        `INSERT INTO shorts_private_input_verifications(id,operation_id,state_hash,started_at) VALUES ${values.join(',')}
        RETURNING id,operation_id,verified_at,expires_at`,
        args,
      );
    });
  }
  /** Only the deletion operator can consume an unexpired proof once. */
  async issue(
    scope: ShortsScope,
    id: string,
    verification: string,
    attempt: string,
  ) {
    this.uuid(verification);
    this.uuid(attempt);
    return this.transaction(async (db) => {
      if (!(await this.operation(db, scope, id))) throw new NotFoundException();
      const [row] = await db.query(
        `INSERT INTO shorts_private_input_attempts(id,operation_id,verification_id)
        VALUES($1,$2,$3) RETURNING *`,
        [attempt, id, verification],
      );
      return row;
    });
  }
  async dispatch(scope: ShortsScope, id: string, attempt: string) {
    this.uuid(attempt);
    return this.transaction(async (db) => {
      if (!(await this.operation(db, scope, id))) throw new NotFoundException();
      const [bound] = await db.query(
        'SELECT id FROM shorts_private_input_attempts WHERE id=$1 AND operation_id=$2',
        [attempt, id],
      );
      if (!bound) throw new NotFoundException();
      const [{ dispatch }] = await db.query(
        'SELECT shorts_private_cleanup_dispatch($1) AS dispatch',
        [attempt],
      );
      return dispatch as Omit<PrivateCleanupSnapshot, 'records'> & {
        attemptId: string;
        issuedAt: string;
        expiresAt: string;
      };
    });
  }
  async outcome(
    scope: ShortsScope,
    id: string,
    attempt: string,
    kind: 'uncertain' | 'removed',
  ) {
    this.uuid(attempt);
    if (!['uncertain', 'removed'].includes(kind))
      throw new Error('Invalid private cleanup outcome');
    return this.transaction(async (db) => {
      if (!(await this.operation(db, scope, id))) throw new NotFoundException();
      const [bound] = await db.query(
        'SELECT id FROM shorts_private_input_attempts WHERE id=$1 AND operation_id=$2',
        [attempt, id],
      );
      if (!bound) throw new NotFoundException();
      const [saved] = await db.query(
        'SELECT * FROM shorts_private_input_outcomes WHERE attempt_id=$1 AND kind=$2',
        [attempt, kind],
      );
      if (saved) return saved;
      await db.query(
        `INSERT INTO shorts_private_input_outcomes(id,attempt_id,kind) VALUES($1,$2,$3) ON CONFLICT(attempt_id,kind) DO NOTHING`,
        [randomUUID(), attempt, kind],
      );
      const [row] = await db.query(
        'SELECT * FROM shorts_private_input_outcomes WHERE attempt_id=$1 AND kind=$2',
        [attempt, kind],
      );
      return row;
    });
  }
}
