import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import { ShortsRetentionService } from './shorts-retention.service';
import { ShortsSourceReaderService } from './shorts-source-reader.service';
import {
  PrivateObjectRef,
  ShortsPrivateObjectsService,
} from './shorts-private-objects.service';
import {
  SHORTS_STORAGE_RECONCILIATION_CONFIG,
  StorageReconciliationConfig,
} from './shorts-storage-reconciliation.config';

const validId = (id: unknown) => {
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
  )
    throw new BadRequestException('Invalid reference scan ID');
};
const fingerprint = (root: any) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        ...root,
        objects: [...root.objects].sort((a, b) => a.key.localeCompare(b.key)),
        manifestSources: [...root.manifestSources].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      }),
    )
    .digest('hex');

/** Historical reference evidence only. Cleanup must independently recheck live writers and holds. */
@Injectable()
export class ShortsStorageReconciliationService {
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    @Inject(SHORTS_STORAGE_RECONCILIATION_CONFIG)
    private readonly config: StorageReconciliationConfig,
    private readonly records: ShortsRetentionService,
    private readonly sources: ShortsSourceReaderService,
    private readonly privateObjects: ShortsPrivateObjectsService,
  ) {}
  private args(id: string) {
    validId(id);
    return [this.config.scope.network, this.config.scope.contract, id];
  }
  async verify() {
    await this.records.verify('read-only');
    for (const table of [
      'shorts_storage_inventory_runs',
      'shorts_storage_inventory_objects',
      'shorts_storage_reconciliations',
      'shorts_storage_reference_roots',
      'shorts_storage_references',
    ]) {
      const [access] = await this.db.query(
        `SELECT has_table_privilege($1,'SELECT') AS reads,
        has_table_privilege($1,'INSERT') AS inserts,has_any_column_privilege($1,'INSERT') AS any_insert,
        has_table_privilege($1,'UPDATE') AS updates,has_any_column_privilege($1,'UPDATE') AS any_update,
        has_table_privilege($1,'DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,'REFERENCES') AS destructive,
        relrowsecurity AS filtered FROM pg_class WHERE oid=$1::regclass`,
        [table],
      );
      const inventory = table.startsWith('shorts_storage_inventory_'),
        mutable = table === 'shorts_storage_reconciliations';
      if (
        !access?.reads ||
        access.filtered ||
        access.destructive ||
        (inventory ? access.any_insert : !access.inserts) ||
        (mutable ? !access.updates : access.any_update)
      )
        throw new Error('Invalid storage reconciliation database grants');
    }
  }
  private async inventory(id: string) {
    const [row] = await this.db.query(
      'SELECT * FROM shorts_storage_inventory_runs WHERE network=$1 AND contract=$2 AND id=$3',
      this.args(id),
    );
    if (
      !row ||
      !row.complete ||
      row.source_hash !== this.config.sourceHash ||
      row.storage_id !== this.config.storageId ||
      row.object_prefix !== this.config.objectPrefix
    )
      throw new ConflictException(
        'Use a completed inventory for this exact deployment and storage configuration',
      );
    return row;
  }
  private async run(id: string) {
    const [run] = await this.db.query(
      'SELECT * FROM shorts_storage_reconciliations WHERE network=$1 AND contract=$2 AND id=$3',
      this.args(id),
    );
    if (!run) throw new NotFoundException('Reference scan not found');
    await this.inventory(run.inventory_id);
    return run;
  }
  async start(id: string, inventoryId: string) {
    await this.inventory(inventoryId);
    await this.db.query(
      `INSERT INTO shorts_storage_reconciliations(network,contract,id,inventory_id)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [...this.args(id), inventoryId],
    );
    const run = await this.run(id);
    if (run.inventory_id !== inventoryId)
      throw new ConflictException('Scan ID belongs to another inventory');
    return this.status(id);
  }
  async step(id: string, signal?: AbortSignal) {
    const abort = AbortSignal.any([
      AbortSignal.timeout(60000),
      ...(signal ? [signal] : []),
    ]);
    abort.throwIfAborted();
    const run = await this.run(id);
    if (run.complete) return this.status(id);
    const page = await this.records.inventory(run.after_resource, 1),
      root = page.items[0];
    const refs = new Map<string, PrivateObjectRef>();
    const add = (ref: PrivateObjectRef) => {
      this.privateObjects.validateReference(this.config.scope, ref);
      const old = refs.get(ref.key);
      if (
        old &&
        (old.bytes !== ref.bytes ||
          old.sha256 !== ref.sha256 ||
          old.keyId !== ref.keyId)
      )
        throw new ConflictException('Conflicting source references');
      refs.set(ref.key, {
        key: ref.key,
        keyId: ref.keyId,
        sha256: ref.sha256,
        bytes: ref.bytes,
      });
      if (refs.size > 256)
        throw new Error('Reference root exceeds the inventory budget');
    };
    if (root) {
      root.objects.forEach(add);
      const seen = new Set<string>();
      for (const source of root.manifestSources) {
        abort.throwIfAborted();
        // Identity is part of the cache key: never skip another claimant's validation.
        const key = JSON.stringify(source);
        if (seen.has(key)) continue;
        seen.add(key);
        const parts = await this.sources.manifestParts(
          this.config.scope,
          source,
          abort,
        );
        parts.forEach(add);
      }
    }
    abort.throwIfAborted();
    const fresh = (await this.records.inventory(run.after_resource, 1))
      .items[0];
    if (
      !!root !== !!fresh ||
      (root && fingerprint(root) !== fingerprint(fresh))
    )
      throw new ConflictException(
        'Media references or holds changed during inspection; resume this scan',
      );
    await this.db.transaction(async (db) => {
      const args = this.args(id);
      const [current] = await db.query(
        'SELECT * FROM shorts_storage_reconciliations WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        args,
      );
      abort.throwIfAborted();
      if (current.complete || current.after_resource !== run.after_resource)
        throw new ConflictException(
          'Another process advanced the reference scan; read saved status',
        );
      if (root) {
        const incoming = JSON.stringify(
          [...refs.values()].map((ref) => ({
            object_key: ref.key,
            key_id: ref.keyId,
            sha256: ref.sha256,
            bytes: String(ref.bytes),
          })),
        );
        const columns = 'object_key text,key_id text,sha256 text,bytes bigint';
        const [conflict] = await db.query(
          `SELECT EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb) AS x(${columns})
          JOIN shorts_storage_references r ON r.network=$1 AND r.contract=$2 AND r.run_id=$3 AND r.object_key=x.object_key
          WHERE ROW(r.key_id,r.sha256,r.bytes) IS DISTINCT FROM ROW(x.key_id,x.sha256,x.bytes)) AS found`,
          [...args, incoming],
        );
        if (conflict.found)
          throw new ConflictException(
            'Different roots disagree on an immutable object',
          );
        await db.query(
          `INSERT INTO shorts_storage_reference_roots(network,contract,run_id,resource_id,fingerprint,active_holds,reasons)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [
            ...args,
            root.id,
            fingerprint(root),
            root.activeHolds,
            JSON.stringify(
              root.retainReasons.filter(
                (reason) => reason !== 'manifest-children-not-inventoried',
              ),
            ),
          ],
        );
        await db.query(
          `INSERT INTO shorts_storage_references(network,contract,run_id,resource_id,object_key,key_id,sha256,bytes)
          SELECT $1,$2,$3,$4,x.* FROM jsonb_to_recordset($5::jsonb) AS x(${columns})`,
          [...args, root.id, incoming],
        );
      }
      abort.throwIfAborted();
      await db.query(
        `UPDATE shorts_storage_reconciliations SET after_resource=$4,complete=$5,roots=roots+$6,
        reference_count=reference_count+$7,updated_at=clock_timestamp() WHERE network=$1 AND contract=$2 AND id=$3`,
        [
          ...args,
          root?.id || run.after_resource,
          !root || !page.next,
          root ? 1 : 0,
          refs.size,
        ],
      );
    });
    return this.status(id);
  }
  async status(id: string) {
    const run = await this.run(id);
    return {
      id,
      inventoryId: run.inventory_id,
      referenceTraversalComplete: run.complete,
      roots: run.roots,
      references: run.reference_count,
      after: run.after_resource,
      updatedAt: run.updated_at.toISOString(),
      consistentSnapshot: false,
      deletionEnabled: false,
    };
  }
  private page(after: string, limit: number) {
    if (
      typeof after !== 'string' ||
      (after && !/^[a-f0-9]{64}$/.test(after)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('Invalid reconciliation page');
  }
  async objects(id: string, after = '', limit = 100) {
    this.page(after, limit);
    const run = await this.run(id);
    if (!run.complete)
      throw new ConflictException(
        'Finish the reference scan before matching inventory',
      );
    const rows = await this.db.query(
      `SELECT o.identity,o.object_key AS key,o.version_id AS version,o.deleted,o.latest,o.bytes::text,
      (SELECT count(*)::text FROM shorts_storage_references r WHERE r.network=o.network AND r.contract=o.contract AND r.run_id=$3 AND r.object_key=o.object_key) AS references,
      EXISTS(SELECT 1 FROM shorts_storage_references r JOIN shorts_storage_reference_roots root USING(network,contract,run_id,resource_id)
        WHERE r.network=o.network AND r.contract=o.contract AND r.run_id=$3 AND r.object_key=o.object_key AND root.active_holds>0)
        OR EXISTS(SELECT 1 FROM shorts_storage_reference_roots root WHERE root.network=o.network AND root.contract=o.contract AND root.run_id=$3
        AND root.resource_id=split_part(substring(o.object_key FROM length($7)+1),'/',1) AND root.active_holds>0) AS held,
      EXISTS(SELECT 1 FROM shorts_storage_references r WHERE r.network=o.network AND r.contract=o.contract AND r.run_id=$3 AND r.object_key=o.object_key
        AND o.latest AND NOT o.deleted AND o.bytes<>r.bytes+36) AS "sizeMismatch"
      FROM shorts_storage_inventory_objects o WHERE o.network=$1 AND o.contract=$2 AND o.run_id=$4 AND o.identity>$5 ORDER BY o.identity LIMIT $6`,
      [
        ...this.args(id),
        run.inventory_id,
        after,
        limit + 1,
        this.config.objectPrefix,
      ],
    );
    return {
      items: rows.slice(0, limit).map((row) => ({
        ...row,
        classification: row.held
          ? 'held'
          : row.references !== '0'
            ? 'referenced'
            : 'unresolved',
        eligibleForDeletion: false,
      })),
      next: rows.length > limit ? rows[limit - 1].identity : null,
      consistentSnapshot: false,
      deletionEnabled: false,
    };
  }
  async references(id: string, after = '', limit = 100) {
    if (
      typeof after !== 'string' ||
      after.length > 850 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('Invalid reference page');
    let cursor = ['', ''];
    if (after) {
      try {
        cursor = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 2 ||
          !/^[a-zA-Z0-9_-]{1,80}$/.test(cursor[0]) ||
          typeof cursor[1] !== 'string' ||
          !cursor[1].startsWith(this.config.objectPrefix) ||
          !/^[a-zA-Z0-9_/-]{1,512}$/.test(cursor[1]) ||
          Buffer.from(JSON.stringify(cursor)).toString('base64url') !== after
        )
          throw new Error('Invalid cursor');
      } catch {
        throw new BadRequestException('Invalid reference cursor');
      }
    }
    const run = await this.run(id);
    if (!run.complete)
      throw new ConflictException(
        'Finish the reference scan before matching inventory',
      );
    const rows = await this.db.query(
      `SELECT r.resource_id AS "resourceId",r.object_key AS key,r.key_id AS "keyId",r.sha256,r.bytes::text,
      root.active_holds>0 AS held,root.reasons,
      (SELECT count(*)::integer FROM shorts_storage_inventory_objects o
        WHERE o.network=r.network AND o.contract=r.contract AND o.run_id=$4 AND o.object_key=r.object_key AND o.latest) AS observations,
      EXISTS(SELECT 1 FROM shorts_storage_inventory_objects o
        WHERE o.network=r.network AND o.contract=r.contract AND o.run_id=$4 AND o.object_key=r.object_key AND o.latest AND o.deleted) AS deleted,
      EXISTS(SELECT 1 FROM shorts_storage_inventory_objects o
        WHERE o.network=r.network AND o.contract=r.contract AND o.run_id=$4 AND o.object_key=r.object_key AND o.latest AND NOT o.deleted AND o.bytes<>r.bytes+36) AS "sizeMismatch"
      FROM shorts_storage_references r JOIN shorts_storage_reference_roots root USING(network,contract,run_id,resource_id)
      WHERE r.network=$1 AND r.contract=$2 AND r.run_id=$3 AND (r.resource_id,r.object_key)>($5,$6)
      ORDER BY r.resource_id,r.object_key LIMIT $7`,
      [...this.args(id), run.inventory_id, ...cursor, limit + 1],
    );
    const items = rows.slice(0, limit).map((row) => ({
      ...row,
      availability:
        row.observations === 0
          ? 'not-observed'
          : row.observations > 1
            ? 'conflicting-latest-observations'
            : row.deleted
              ? 'delete-marker'
              : row.sizeMismatch
                ? 'size-mismatch'
                : 'observed',
      eligibleForDeletion: false,
    }));
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit
          ? Buffer.from(JSON.stringify([last.resourceId, last.key])).toString(
              'base64url',
            )
          : null,
      consistentSnapshot: false,
      deletionEnabled: false,
    };
  }
}
