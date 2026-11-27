import {
  ConflictException,
  Inject,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import {
  SHORTS_STORAGE_RECONCILIATION_CONFIG,
  StorageReconciliationConfig,
} from './shorts-storage-reconciliation.config';
import { ShortsPrivateInputCleanupJournalService } from './shorts-private-input-cleanup-journal.service';
import { ShortsPrivateInputVersionStorageService } from './shorts-private-input-version-storage.service';
import { ShortsPrivateInputCleanupClientService } from './shorts-private-input-cleanup-client.service';
import {
  PrivateCleanupCandidate,
  privateCleanupCandidates,
} from './shorts-private-cleanup-batch';

/** Explicit operations only; a saved verification is never reused for another dispatch. */
@Injectable()
export class ShortsPrivateInputCleanupService implements OnModuleDestroy {
  private readonly enabled: boolean;
  private readonly shutdown = new AbortController();
  private pending?: Promise<unknown>;
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    @Inject(SHORTS_STORAGE_RECONCILIATION_CONFIG)
    private readonly config: StorageReconciliationConfig,
    private readonly journal: ShortsPrivateInputCleanupJournalService,
    private readonly storage: ShortsPrivateInputVersionStorageService,
    private readonly verifier: ShortsPrivateInputCleanupClientService,
  ) {
    const flag =
      process.env.SHORTS_PRIVATE_INPUT_CLEANUP_OPERATOR_ENABLED ?? 'false';
    if (!['true', 'false'].includes(flag))
      throw new Error('Invalid private input cleanup operator flag');
    this.enabled = flag === 'true';
  }
  async verify() {
    const [role] = await this.db
      .query(`SELECT current_user=session_user AS direct,
      rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid) AS privileged,
      has_schema_privilege(current_schema(),'CREATE') AS creates_schema FROM pg_roles r WHERE rolname=current_user`);
    if (!role?.direct || role.privileged || role.creates_schema)
      throw new Error('Use a dedicated restricted cleanup login');
    const reads = new Set([
      'shorts_runtime',
      'shorts_private_input_barriers',
      'shorts_private_input_cleanup',
      'shorts_private_input_verifications',
      'shorts_private_input_attempts',
      'shorts_private_input_outcomes',
    ]);
    const inserts = new Set([
      'shorts_private_input_cleanup',
      'shorts_private_input_attempts',
      'shorts_private_input_outcomes',
    ]);
    for (const table of [
      ...reads,
      'shorts_content',
      'shorts_ingestion',
      'shorts_upload_sessions',
      'shorts_upload_parts',
      'shorts_retention_holds',
      'shorts_delivery_packages',
      'shorts_delivery_generations',
      'shorts_delivery_staging',
      'shorts_delivery_selections',
      'shorts_private_storage_epochs',
      'shorts_private_cleanup_scopes',
      'shorts_private_input_retirements',
      'shorts_storage_inventory_runs',
      'shorts_storage_inventory_objects',
      'shorts_storage_reconciliations',
      'shorts_storage_reference_roots',
      'shorts_storage_references',
    ]) {
      const [access] = await this.db.query(
        `SELECT has_table_privilege($1,'SELECT') AS reads,has_table_privilege($1,'INSERT') AS inserts,
        has_any_column_privilege($1,'INSERT') AS any_insert,
        has_table_privilege($1,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,'UPDATE,REFERENCES') AS writes,
        relrowsecurity AS filtered FROM pg_class WHERE oid=$1::regclass`,
        [table],
      );
      if (
        !access ||
        (reads.has(table) && !access.reads) ||
        access.writes ||
        access.filtered ||
        (inserts.has(table) ? !access.inserts : access.any_insert)
      )
        throw new Error('Invalid private cleanup database grants');
    }
    for (const fn of [
      'shorts_private_sealed_snapshot(uuid)',
      'shorts_private_cleanup_snapshot(uuid)',
      'shorts_private_cleanup_dispatch(uuid)',
    ]) {
      const [access] = await this.db.query(
        "SELECT has_function_privilege($1,'EXECUTE') AS allowed",
        [fn],
      );
      if (!access?.allowed)
        throw new Error('Missing private cleanup function grants');
    }
    const [runtime] = await this.db.query(
      'SELECT source_hash FROM shorts_runtime WHERE network=$1 AND contract=$2',
      [this.config.scope.network, this.config.scope.contract],
    );
    if (runtime?.source_hash !== this.config.sourceHash)
      throw new Error('Cleanup deployment mismatch');
  }
  async status(id: string) {
    const saved = await this.journal.get(this.config.scope, id);
    if (
      saved &&
      (saved.operation.storage_id !== this.config.storageId ||
        saved.operation.source_hash !== this.config.sourceHash ||
        !saved.operation.object_key.startsWith(this.config.objectPrefix))
    )
      throw new ConflictException('Cleanup storage deployment changed');
    return saved;
  }
  private ref(op: any) {
    return {
      key: op.object_key,
      keyId: op.key_id,
      sha256: op.sha256,
      bytes: Number(op.bytes),
    };
  }
  private async run<T>(
    parent: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    if (this.pending || this.shutdown.signal.aborted)
      throw new ConflictException('Cleanup process is busy or stopped');
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(360000),
      ...(parent ? [parent] : []),
    ]);
    signal.throwIfAborted();
    const task = work(signal);
    this.pending = task;
    try {
      return await task;
    } finally {
      this.pending = undefined;
    }
  }
  private async observe(id: string, signal: AbortSignal) {
    const saved = await this.status(id);
    if (!saved || saved.operation.removed || !saved.attempts.length)
      return saved;
    const attempt = saved.attempts.at(-1),
      op = saved.operation;
    // Presence/absence alone is not authority: only an already issued version can settle.
    if (
      await this.storage.absent(
        this.config.scope,
        this.ref(op),
        op.version_id,
        signal,
      )
    ) {
      await this.journal.outcome(this.config.scope, id, attempt.id, 'removed');
      return this.status(id);
    }
    return saved;
  }
  recover(id: string, parent?: AbortSignal) {
    return this.run(parent, (signal) => this.observe(id, signal));
  }
  private async prepareCandidate(
    request: PrivateCleanupCandidate,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const { id, barrier, inventory, identity } = request;
    const saved = await this.status(id);
    if (
      saved &&
      (saved.operation.barrier_id !== barrier ||
        saved.operation.inventory_id !== inventory ||
        saved.operation.identity !== identity)
    )
      throw new ConflictException('Cleanup identity was already used');
    if (!saved)
      await this.journal.reserve(
        this.config.scope,
        id,
        barrier,
        inventory,
        identity,
      );
    return (await this.observe(id, signal))!;
  }
  private async remove(
    id: string,
    signal: AbortSignal,
    work: Awaited<
      ReturnType<ShortsPrivateInputVersionStorageService['prepare']>
    >,
    proof: () => Promise<{ id: string }>,
  ) {
    let attempt: string | undefined;
    try {
      await work(async () => {
        signal.throwIfAborted();
        const verification = await proof();
        signal.throwIfAborted();
        attempt = randomUUID();
        await this.journal.issue(
          this.config.scope,
          id,
          verification.id,
          attempt,
        );
        signal.throwIfAborted();
        const dispatch = await this.journal.dispatch(
          this.config.scope,
          id,
          attempt,
        );
        return {
          ...dispatch,
          issuedAt: new Date(dispatch.issuedAt),
          expiresAt: new Date(dispatch.expiresAt),
          assertCurrent: async () => {
            signal.throwIfAborted();
            await this.journal.dispatch(this.config.scope, id, attempt!);
            signal.throwIfAborted();
          },
        };
      });
      await this.journal.outcome(this.config.scope, id, attempt!, 'removed');
    } catch (error) {
      // A lost issue/DELETE/commit response may already have taken effect. Never retry here.
      if (attempt)
        await this.journal
          .outcome(this.config.scope, id, attempt, 'uncertain')
          .catch(() => {});
      throw error;
    }
    return this.status(id);
  }
  reclaimMany(input: unknown, parent?: AbortSignal) {
    return this.run(parent, async (signal) => {
      if (!this.enabled)
        throw new ConflictException(
          'Private input cleanup operator is disabled',
        );
      const requests = privateCleanupCandidates(input);
      const pending: {
        id: string;
        remove: Awaited<
          ReturnType<ShortsPrivateInputVersionStorageService['prepare']>
        >;
      }[] = [];
      const results = new Map<
        string,
        Awaited<ReturnType<typeof this.status>>
      >();
      for (const request of requests) {
        const saved = await this.prepareCandidate(request, signal);
        if (saved.operation.removed) {
          results.set(request.id, saved);
          continue;
        }
        pending.push({
          id: request.id,
          remove: await this.storage.prepare(
            this.config.scope,
            this.ref(saved.operation),
            saved.operation.version_id,
            signal,
          ),
        });
      }
      if (pending.length) {
        signal.throwIfAborted();
        const proofs = await this.verifier.verifyMany(
          pending.map((item) => ({
            operationId: item.id,
            verificationId: randomUUID(),
          })),
          signal,
        );
        for (const [index, item] of pending.entries())
          results.set(
            item.id,
            await this.remove(
              item.id,
              signal,
              item.remove,
              async () => proofs[index],
            ),
          );
      }
      return requests.map((request) => results.get(request.id)!);
    });
  }
  reclaim(
    id: string,
    barrier: string,
    inventory: string,
    identity: string,
    parent?: AbortSignal,
  ) {
    return this.run(parent, async (signal) => {
      if (!this.enabled)
        throw new ConflictException(
          'Private input cleanup operator is disabled',
        );
      const [request] = privateCleanupCandidates([
        { id, barrier, inventory, identity },
      ]);
      const saved = await this.prepareCandidate(request, signal);
      if (saved.operation.removed) return saved;
      const op = saved.operation;
      return this.remove(
        id,
        signal,
        (issue) =>
          this.storage.remove(
            this.config.scope,
            this.ref(op),
            op.version_id,
            signal,
            issue,
          ),
        () => this.verifier.verify(id, randomUUID(), signal),
      );
    });
  }
  async onModuleDestroy() {
    this.shutdown.abort();
    if (this.pending) await Promise.allSettled([this.pending]);
  }
}
