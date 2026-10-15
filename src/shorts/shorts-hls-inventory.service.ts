import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import { ShortsRetentionService } from './shorts-retention.service';
import {
  HlsInventoryConfig,
  SHORTS_HLS_INVENTORY_CONFIG,
} from './shorts-hls-inventory.config';
import { ShortsHlsIndexReaderService } from './shorts-hls-index-reader.service';
import { hlsSourceKey } from './shorts-hls-inventory-data';

@Injectable()
export class ShortsHlsInventoryService {
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    @Inject(SHORTS_HLS_INVENTORY_CONFIG)
    private readonly config: HlsInventoryConfig,
    private readonly records: ShortsRetentionService,
    private readonly index: ShortsHlsIndexReaderService,
  ) {}
  private args(id: string) {
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
    )
      throw new BadRequestException('Invalid HLS scan ID');
    return [this.config.scope.network, this.config.scope.contract, id];
  }
  async verify() {
    await this.records.verify('read-only');
    for (const table of [
      'shorts_hls_inventory_runs',
      'shorts_hls_inventory_roots',
      'shorts_hls_inventory_entries',
      'shorts_hls_inventory_pages',
    ]) {
      const [access] = await this.db.query(
        `SELECT has_table_privilege($1,'SELECT') AS reads,has_table_privilege($1,'INSERT') AS inserts,
        has_table_privilege($1,'UPDATE') AS updates,has_any_column_privilege($1,'UPDATE') AS any_update,
        has_table_privilege($1,'DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,'REFERENCES') AS destructive,
        relrowsecurity AS filtered FROM pg_class WHERE oid=$1::regclass`,
        [table],
      );
      if (
        !access?.reads ||
        !access.inserts ||
        access.destructive ||
        access.filtered ||
        (table.endsWith('_runs') ? !access.updates : access.any_update)
      )
        throw new Error('Invalid HLS inventory database grants');
    }
  }
  private async run(id: string) {
    const [run] = await this.db.query(
      'SELECT * FROM shorts_hls_inventory_runs WHERE network=$1 AND contract=$2 AND id=$3',
      this.args(id),
    );
    if (!run) throw new NotFoundException('HLS scan not found');
    if (
      run.source_hash !== this.config.sourceHash ||
      run.storage_id !== this.config.storageId ||
      run.namespace !== this.config.namespace
    )
      throw new ConflictException(
        'HLS inventory configuration changed; use a new run',
      );
    return run;
  }
  async start(id: string) {
    await this.db.query(
      `INSERT INTO shorts_hls_inventory_runs(network,contract,id,source_hash,storage_id,namespace)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        ...this.args(id),
        this.config.sourceHash,
        this.config.storageId,
        this.config.namespace,
      ],
    );
    return this.status(id);
  }
  async step(id: string, signal?: AbortSignal) {
    const abort = AbortSignal.any([
      AbortSignal.timeout(30000),
      ...(signal ? [signal] : []),
    ]);
    abort.throwIfAborted();
    const run = await this.run(id);
    if (run.phase === 'complete') return this.status(id);
    const logical =
      run.phase === 'references'
        ? await this.records.inventory(run.after_resource, 25)
        : null;
    const physical =
      run.phase === 'index'
        ? await this.index.page(run.redis_cursor, abort)
        : null;
    const roots =
      logical?.items.map((root) => ({
        resource_id: root.id,
        source_key: root.hlsSource ? hlsSourceKey(root.hlsSource) : null,
        source_cid: root.hlsSource?.cid || null,
        active_holds: root.activeHolds,
        reasons: root.retainReasons,
      })) || [];
    abort.throwIfAborted();
    await this.db.transaction(async (db) => {
      const args = this.args(id);
      const [current] = await db.query(
        'SELECT * FROM shorts_hls_inventory_runs WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        args,
      );
      abort.throwIfAborted();
      if (
        current.phase !== run.phase ||
        current.pages !== run.pages ||
        current.after_resource !== run.after_resource ||
        current.redis_cursor !== run.redis_cursor
      )
        throw new ConflictException(
          'Another process advanced the HLS scan; read saved status',
        );
      if (logical) {
        await db.query(
          `INSERT INTO shorts_hls_inventory_roots(network,contract,run_id,resource_id,source_key,source_cid,active_holds,reasons)
          SELECT $1,$2,$3,x.* FROM jsonb_to_recordset($4::jsonb) AS x(resource_id text,source_key text,source_cid text,active_holds integer,reasons jsonb)`,
          [...args, JSON.stringify(roots)],
        );
        await db.query(
          `UPDATE shorts_hls_inventory_runs SET after_resource=$4,phase=$5,roots=roots+$6,updated_at=clock_timestamp()
          WHERE network=$1 AND contract=$2 AND id=$3`,
          [
            ...args,
            roots.at(-1)?.resource_id || run.after_resource,
            logical.next ? 'references' : 'index',
            roots.length,
          ],
        );
      } else if (physical) {
        if (run.redis_epoch && run.redis_epoch !== physical.epoch)
          throw new ConflictException(
            'Redis restarted or changed; start a new HLS inventory',
          );
        if (physical.next !== '0') {
          const [seen] = await db.query(
            'SELECT EXISTS(SELECT 1 FROM shorts_hls_inventory_pages WHERE network=$1 AND contract=$2 AND run_id=$3 AND cursor=$4) AS found',
            [...args, physical.next],
          );
          if (physical.next === run.redis_cursor || seen.found)
            throw new ConflictException(
              'HLS scan cursor repeated; start a new run',
            );
        }
        const entries = JSON.stringify(
          physical.items.map((item) => ({
            source_key: item.sourceKey,
            cid: item.cid,
            metadata_hash: item.hash,
            bytes: item.bytes,
            files: item.files,
          })),
        );
        const columns =
          'source_key text,cid text,metadata_hash text,bytes bigint,files jsonb';
        const [conflict] = await db.query(
          `SELECT EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb) AS x(${columns})
          JOIN shorts_hls_inventory_entries e ON e.network=$1 AND e.contract=$2 AND e.run_id=$3 AND e.source_key=x.source_key
          WHERE e.metadata_hash<>x.metadata_hash) AS found`,
          [...args, entries],
        );
        if (conflict.found)
          throw new ConflictException(
            'An HLS index changed during inventory; start a new run',
          );
        const [added] = await db.query(
          `WITH inserted AS (INSERT INTO shorts_hls_inventory_entries(network,contract,run_id,source_key,cid,metadata_hash,bytes,files)
          SELECT $1,$2,$3,x.* FROM jsonb_to_recordset($4::jsonb) AS x(${columns}) ON CONFLICT DO NOTHING RETURNING bytes)
          SELECT count(*)::text AS n,coalesce(sum(bytes),0)::text AS bytes FROM inserted`,
          [...args, entries],
        );
        await db.query(
          'INSERT INTO shorts_hls_inventory_pages(network,contract,run_id,cursor) VALUES($1,$2,$3,$4)',
          [...args, run.redis_cursor],
        );
        await db.query(
          `UPDATE shorts_hls_inventory_runs SET redis_cursor=$4,phase=$5,pages=pages+1,entries=entries+$6,indexed_bytes=indexed_bytes+$7,
          redis_epoch=$8,updated_at=clock_timestamp() WHERE network=$1 AND contract=$2 AND id=$3`,
          [
            ...args,
            physical.next,
            physical.next === '0' ? 'complete' : 'index',
            added.n,
            added.bytes,
            physical.epoch,
          ],
        );
      }
      abort.throwIfAborted();
    });
    return this.status(id);
  }
  async status(id: string) {
    const run = await this.run(id);
    return {
      id,
      namespace: run.namespace,
      storageId: run.storage_id,
      phase: run.phase,
      after: run.after_resource,
      cursor: run.redis_cursor,
      redisEpoch: run.redis_epoch,
      pages: run.pages,
      roots: run.roots,
      entries: run.entries,
      indexedMediaBytes: run.indexed_bytes,
      updatedAt: run.updated_at.toISOString(),
      indexTraversalComplete: run.phase === 'complete',
      consistentSnapshot: false,
      physicalPinInventoryComplete: false,
      deletionEnabled: false,
    };
  }
  async entries(id: string, after = '', limit = 100) {
    if (
      typeof after !== 'string' ||
      (after && !/^[a-f0-9]{64}$/.test(after)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('Invalid HLS inventory page');
    const run = await this.run(id);
    if (run.phase !== 'complete')
      throw new ConflictException(
        'Finish the HLS scan before matching references',
      );
    const rows = await this.db.query(
      `SELECT e.source_key AS "sourceKey",e.cid,e.bytes::text,e.files,
      (SELECT count(*)::text FROM shorts_hls_inventory_roots r WHERE r.network=e.network AND r.contract=e.contract AND r.run_id=e.run_id AND r.source_key=e.source_key) AS references,
      (SELECT count(*)::text FROM shorts_hls_inventory_entries shared WHERE shared.network=e.network AND shared.contract=e.contract AND shared.run_id=e.run_id AND shared.cid=e.cid) AS "packageReferences",
      EXISTS(SELECT 1 FROM shorts_hls_inventory_entries shared JOIN shorts_hls_inventory_roots r USING(network,contract,run_id,source_key)
        WHERE shared.network=e.network AND shared.contract=e.contract AND shared.run_id=e.run_id AND shared.cid=e.cid AND r.active_holds>0) AS held
      FROM shorts_hls_inventory_entries e WHERE e.network=$1 AND e.contract=$2 AND e.run_id=$3 AND e.source_key>$4 ORDER BY e.source_key LIMIT $5`,
      [...this.args(id), after, limit + 1],
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
      next: rows.length > limit ? rows[limit - 1].sourceKey : null,
      consistentSnapshot: false,
      deletionEnabled: false,
    };
  }
  async roots(id: string, after = '', limit = 100) {
    if (
      typeof after !== 'string' ||
      (after && !/^[a-zA-Z0-9_-]{1,80}$/.test(after)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('Invalid HLS root page');
    const run = await this.run(id);
    if (run.phase !== 'complete')
      throw new ConflictException(
        'Finish the HLS scan before matching references',
      );
    const rows = await this.db.query(
      `SELECT r.resource_id AS id,r.source_key AS "sourceKey",r.source_cid AS "sourceCid",r.active_holds AS "activeHolds",r.reasons,
      EXISTS(SELECT 1 FROM shorts_hls_inventory_entries e WHERE e.network=r.network AND e.contract=r.contract AND e.run_id=r.run_id AND e.source_key=r.source_key) AS "indexObserved"
      FROM shorts_hls_inventory_roots r WHERE r.network=$1 AND r.contract=$2 AND r.run_id=$3 AND r.resource_id>$4 ORDER BY r.resource_id LIMIT $5`,
      [...this.args(id), after, limit + 1],
    );
    return {
      items: rows
        .slice(0, limit)
        .map((row) => ({ ...row, eligibleForDeletion: false })),
      next: rows.length > limit ? rows[limit - 1].id : null,
      consistentSnapshot: false,
      deletionEnabled: false,
    };
  }
}
