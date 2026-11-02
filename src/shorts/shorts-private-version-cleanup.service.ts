import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ShortsRetentionService } from './shorts-retention.service';
import { ShortsDatabaseService } from './shorts-database.service';
import { ShortsPrivateObjectsService } from './shorts-private-objects.service';
import { ShortsPrivateVersionStorageService } from './shorts-private-version-storage.service';
import { ShortsStorageReconciliationService } from './shorts-storage-reconciliation.service';
import {
  SHORTS_STORAGE_RECONCILIATION_CONFIG,
  StorageReconciliationConfig,
} from './shorts-storage-reconciliation.config';

@Injectable()
export class ShortsPrivateVersionCleanupService implements OnModuleDestroy {
  private readonly enabled: boolean;
  private readonly shutdown = new AbortController();
  private pending?: Promise<unknown>;
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    @Inject(SHORTS_STORAGE_RECONCILIATION_CONFIG)
    private readonly config: StorageReconciliationConfig,
    private readonly objects: ShortsPrivateObjectsService,
    private readonly storage: ShortsPrivateVersionStorageService,
    private readonly inspection: ShortsStorageReconciliationService,
    private readonly retention: ShortsRetentionService,
  ) {
    const flag = process.env.SHORTS_PRIVATE_VERSION_CLEANUP_ENABLED ?? 'false';
    if (!['true', 'false'].includes(flag))
      throw new Error('Invalid private version cleanup flag');
    this.enabled = flag === 'true';
  }
  private uuid(value: string) {
    if (
      typeof value !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        value,
      )
    )
      throw new BadRequestException('Invalid cleanup identity');
    return value;
  }
  private scope() {
    return [this.config.scope.network, this.config.scope.contract];
  }
  async verify() {
    await this.retention.verify('read-only');
    for (const table of [
      'shorts_storage_inventory_runs',
      'shorts_storage_inventory_objects',
      'shorts_storage_reconciliations',
      'shorts_storage_reference_roots',
      'shorts_storage_references',
    ]) {
      const [access] = await this.db.query(
        `SELECT has_table_privilege($1,'SELECT') AS reads,
        has_table_privilege($1,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,'INSERT,UPDATE,REFERENCES') AS writes,
        relrowsecurity AS filtered FROM pg_class WHERE oid=$1::regclass`,
        [table],
      );
      if (!access.reads || access.writes || access.filtered)
        throw new Error('Cleanup inventories must be read-only');
    }
    const [{ guarded }] = await this.db
      .query(`SELECT count(*)::integer AS guarded FROM pg_trigger
      WHERE tgname='shorts_private_reference_epoch' AND tgenabled IN ('O','A') AND tgrelid=ANY(ARRAY[
        'shorts_content'::regclass,'shorts_ingestion'::regclass,'shorts_upload_sessions'::regclass,'shorts_upload_parts'::regclass,
        'shorts_retention_holds'::regclass,'shorts_delivery_packages'::regclass,'shorts_delivery_generations'::regclass,'shorts_delivery_staging'::regclass])`);
    if (guarded !== 8)
      throw new Error('Private cleanup requires complete source guards');
    for (const table of [
      'shorts_private_storage_epochs',
      'shorts_private_version_cleanup',
      'shorts_private_version_events',
    ]) {
      const [access] = await this.db.query(
        `SELECT has_table_privilege($1,'SELECT') AS reads,has_table_privilege($1,'INSERT') AS inserts,
        has_any_column_privilege($1,'INSERT') AS any_insert,has_table_privilege($1,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,'UPDATE,REFERENCES') AS writes,
        relrowsecurity AS filtered FROM pg_class WHERE oid=$1::regclass`,
        [table],
      );
      if (
        !access.reads ||
        access.writes ||
        access.filtered ||
        (table.endsWith('epochs') ? access.any_insert : !access.inserts)
      )
        throw new Error('Invalid cleanup database grants');
    }
  }
  async status(id: string) {
    const [operation] = await this.db.query(
      'SELECT * FROM shorts_private_version_cleanup WHERE network=$1 AND contract=$2 AND id=$3',
      [...this.scope(), this.uuid(id)],
    );
    if (!operation) return null;
    if (
      operation.storage_id !== this.config.storageId ||
      operation.source_hash !== this.config.sourceHash ||
      !operation.object_key.startsWith(this.config.objectPrefix)
    )
      throw new ConflictException('Cleanup storage deployment changed');
    const events = await this.db.query(
      'SELECT * FROM shorts_private_version_events WHERE operation_id=$1 ORDER BY created_at,id',
      [id],
    );
    return { operation, events };
  }
  private async run<T>(
    parent: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    if (this.pending || this.shutdown.signal.aborted)
      throw new ConflictException('Cleanup process is busy or stopped');
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(180000),
      ...(parent ? [parent] : []),
    ]);
    const task = work(signal);
    this.pending = task;
    try {
      return await task;
    } finally {
      this.pending = undefined;
    }
  }
  private ref(op: any) {
    return {
      key: op.object_key,
      keyId: op.key_id,
      bytes: Number(op.bytes),
      sha256: op.sha256,
    };
  }
  private async event(
    id: string,
    kind: string,
    attempt?: string,
    retained?: string,
    scan?: string,
  ) {
    const [row] = await this.db.query(
      `INSERT INTO shorts_private_version_events(id,operation_id,kind,attempt_id,retained_version,scan_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [randomUUID(), id, kind, attempt ?? null, retained ?? null, scan ?? null],
    );
    return row;
  }
  private async observe(id: string, signal: AbortSignal) {
    const saved = await this.status(id);
    if (!saved || saved.operation.state !== 'pending') return saved;
    const attempt = saved.events
      .filter((event) => event.kind === 'issued')
      .at(-1);
    if (!attempt) return saved;
    const op = saved.operation;
    await this.objects.verifyStoredVersion(
      this.config.scope,
      this.ref(op),
      attempt.retained_version,
      signal,
    );
    if (
      await this.storage.absent(
        op.object_key,
        op.candidate_version,
        attempt.retained_version,
        Number(op.bytes),
        signal,
      )
    ) {
      await this.event(id, 'removed', attempt.id, attempt.retained_version);
      return this.status(id);
    }
    return saved;
  }
  recover(id: string, signal?: AbortSignal) {
    return this.run(signal, (active) => this.observe(this.uuid(id), active));
  }
  async cancel(id: string) {
    const saved = await this.status(id);
    if (!saved)
      throw new BadRequestException(
        'Cleanup operation not found in this deployment',
      );
    if (saved.operation.state !== 'pending') return saved;
    await this.event(this.uuid(id), 'cancelled');
    return this.status(id);
  }
  reclaim(id: string, scan: string, identity: string, parent?: AbortSignal) {
    return this.run(parent, async (signal) => {
      if (!this.enabled)
        throw new ConflictException('Private version cleanup is disabled');
      this.uuid(id);
      this.uuid(scan);
      signal.throwIfAborted();
      let saved = await this.status(id);
      if (saved && saved.operation.identity !== identity)
        throw new ConflictException('Cleanup identity was already used');
      if (saved && saved.operation.state !== 'pending') return saved;
      if (saved) {
        saved = await this.observe(id, signal);
        if (saved.operation.state !== 'pending') return saved;
      }
      // Historical metadata identifies the candidate; the journal guards reject stale
      // policy and the bounded reads below verify its actual bytes after reservation.
      const candidate = await this.inspection.versionCandidate(
        scan,
        identity,
        signal,
      );
      const proof = {
        key: candidate.ref.key,
        candidateVersion: candidate.version,
        sha256: candidate.ref.sha256,
        plaintextBytes: candidate.ref.bytes,
      };
      if (!saved) {
        await this.db.query(
          `INSERT INTO shorts_private_version_cleanup(id,network,contract,scan_id,identity,storage_id,source_hash,object_key,candidate_version,key_id,sha256,bytes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,
          [
            id,
            ...this.scope(),
            scan,
            identity,
            this.config.storageId,
            this.config.sourceHash,
            proof.key,
            proof.candidateVersion,
            candidate.ref.keyId,
            proof.sha256,
            proof.plaintextBytes,
          ],
        );
        saved = await this.status(id);
      }
      const op = saved.operation;
      if (
        op.object_key !== proof.key ||
        op.candidate_version !== proof.candidateVersion ||
        op.sha256 !== proof.sha256 ||
        Number(op.bytes) !== proof.plaintextBytes
      )
        throw new ConflictException('Cleanup content changed');
      const copies = await this.objects.verifyVersionCopies(
        this.config.scope,
        this.ref(op),
        op.candidate_version,
        signal,
      );
      await this.storage.preflight(
        op.object_key,
        copies.retainedVersion,
        Number(op.bytes),
        signal,
      );
      signal.throwIfAborted();
      const issued = await this.event(
        id,
        'issued',
        undefined,
        copies.retainedVersion,
        scan,
      );
      try {
        signal.throwIfAborted();
        await this.storage.remove(
          op.object_key,
          op.candidate_version,
          copies.retainedVersion,
          Number(op.bytes),
          new Date(issued.created_at),
          signal,
          async () => {
            const [current] = await this.db.query(
              `SELECT e.revision,rt.source_hash,o.state FROM shorts_private_storage_epochs e
            JOIN shorts_runtime rt USING(network,contract) JOIN shorts_private_version_cleanup o USING(network,contract)
            WHERE o.id=$1`,
              [id],
            );
            if (
              !current ||
              String(current.revision) !== String(issued.reference_epoch) ||
              current.state !== 'pending' ||
              current.source_hash !== this.config.sourceHash
            )
              throw new ConflictException(
                'Cleanup policy changed before dispatch',
              );
          },
        );
        await this.event(id, 'removed', issued.id, copies.retainedVersion);
      } catch (error) {
        await this.event(id, 'uncertain', issued.id).catch(() => undefined);
        throw error;
      }
      return this.status(id);
    });
  }
  async onModuleDestroy() {
    this.shutdown.abort();
    await this.pending?.catch(() => undefined);
  }
}
