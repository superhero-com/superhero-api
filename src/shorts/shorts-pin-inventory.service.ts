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
  PinInventoryConfig,
  SHORTS_PIN_INVENTORY_CONFIG,
} from './shorts-pin-inventory.config';
import { ShortsPinReaderService, pinCid } from './shorts-pin-reader.service';

const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

@Injectable()
export class ShortsPinInventoryService {
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    @Inject(SHORTS_PIN_INVENTORY_CONFIG)
    private readonly config: PinInventoryConfig,
    private readonly records: ShortsRetentionService,
    private readonly reader: ShortsPinReaderService,
  ) {}
  private args(id: string) {
    if (!uuid(id)) throw new BadRequestException('Invalid pin scan ID');
    return [this.config.scope.network, this.config.scope.contract, id];
  }
  async verify() {
    await this.records.verify('read-only');
    for (const table of [
      'shorts_pin_inventory_runs',
      'shorts_pin_inventory_entries',
      'shorts_hls_inventory_runs',
      'shorts_hls_inventory_roots',
      'shorts_hls_inventory_entries',
    ]) {
      const [access] = await this.db.query(
        `SELECT has_table_privilege($1,'SELECT') AS reads,
        has_table_privilege($1,'INSERT') AS inserts,has_any_column_privilege($1,'INSERT') AS any_insert,
        has_table_privilege($1,'UPDATE') AS updates,has_any_column_privilege($1,'UPDATE') AS any_update,
        has_table_privilege($1,'DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1,'REFERENCES') AS destructive,
        relrowsecurity AS filtered FROM pg_class WHERE oid=$1::regclass`,
        [table],
      );
      if (
        !access?.reads ||
        access.destructive ||
        access.filtered ||
        (table.startsWith('shorts_pin_')
          ? !access.inserts
          : access.any_insert) ||
        (table === 'shorts_pin_inventory_runs'
          ? !access.updates
          : access.any_update)
      )
        throw new Error('Invalid pin inventory database grants');
    }
  }
  private async run(id: string) {
    const [run] = await this.db.query(
      'SELECT * FROM shorts_pin_inventory_runs WHERE network=$1 AND contract=$2 AND id=$3',
      this.args(id),
    );
    if (!run) throw new NotFoundException('Pin scan not found');
    if (
      run.source_hash !== this.config.sourceHash ||
      run.storage_id !== this.config.storageId ||
      run.peer_id !== this.config.peerId
    )
      throw new ConflictException(
        'Pin inventory configuration changed; use a new run',
      );
    return run;
  }
  async scan(id: string, hlsRun: string, signal?: AbortSignal) {
    const args = this.args(id);
    if (!uuid(hlsRun))
      throw new BadRequestException('Invalid HLS reference run');
    const abort = AbortSignal.any([
      AbortSignal.timeout(120000),
      ...(signal ? [signal] : []),
    ]);
    abort.throwIfAborted();
    const inserted = await this.db.transaction(async (db) => {
      const [hls] = await db.query(
        'SELECT source_hash,phase FROM shorts_hls_inventory_runs WHERE network=$1 AND contract=$2 AND id=$3',
        [...args.slice(0, 2), hlsRun],
      );
      if (
        hls?.phase !== 'complete' ||
        hls.source_hash !== this.config.sourceHash
      )
        throw new ConflictException(
          'Use a completed HLS inventory from this deployment',
        );
      return db.query(
        `INSERT INTO shorts_pin_inventory_runs(network,contract,id,source_hash,storage_id,peer_id,hls_run)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
        [
          ...args,
          this.config.sourceHash,
          this.config.storageId,
          this.config.peerId,
          hlsRun,
        ],
      );
    });
    if (!inserted.length) {
      const existing = await this.run(id);
      if (existing.hls_run !== hlsRun)
        throw new ConflictException(
          'Pin run belongs to another reference inventory',
        );
      // No replay/offset is safe: pin/ls has no stable order or resume cursor.
      return this.status(id);
    }
    await this.reader.identity(abort);
    const before = await this.reader.capacity(abort);
    abort.throwIfAborted();
    await this.db.query(
      `UPDATE shorts_pin_inventory_runs SET capacity_before=$4,updated_at=clock_timestamp()
      WHERE network=$1 AND contract=$2 AND id=$3`,
      [...args, JSON.stringify(before)],
    );
    let batches = 0;
    for (const type of ['recursive', 'direct'] as const) {
      for await (const page of this.reader.pins(type, abort)) {
        abort.throwIfAborted();
        await this.db.transaction(async (db) => {
          const [run] = await db.query(
            'SELECT phase,batches FROM shorts_pin_inventory_runs WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
            args,
          );
          if (run.phase !== 'incomplete' || run.batches !== String(batches))
            throw new ConflictException('Pin scan checkpoint changed');
          const [added] = await db.query(
            `WITH added AS (
            INSERT INTO shorts_pin_inventory_entries(network,contract,run_id,cid,type)
            SELECT $1,$2,$3,x.* FROM jsonb_to_recordset($4::jsonb) AS x(cid text,type text)
            ON CONFLICT DO NOTHING RETURNING cid) SELECT count(*)::text AS n FROM added`,
            [...args, JSON.stringify(page)],
          );
          await db.query(
            `UPDATE shorts_pin_inventory_runs SET pins=pins+$4,batches=batches+1,updated_at=clock_timestamp()
            WHERE network=$1 AND contract=$2 AND id=$3`,
            [...args, added.n],
          );
          abort.throwIfAborted();
        });
        batches++;
      }
    }
    await this.reader.identity(abort);
    const after = await this.reader.capacity(abort);
    await this.db.transaction(async (db) => {
      abort.throwIfAborted();
      const changed = await db.query(
        `UPDATE shorts_pin_inventory_runs SET phase='complete',capacity_after=$4,updated_at=clock_timestamp()
        WHERE network=$1 AND contract=$2 AND id=$3 AND phase='incomplete' AND batches=$5 RETURNING id`,
        [...args, JSON.stringify(after), batches],
      );
      if (!changed.length)
        throw new ConflictException('Pin scan checkpoint changed');
      abort.throwIfAborted();
    });
    return this.status(id);
  }
  async status(id: string) {
    const run = await this.run(id);
    return {
      id,
      phase: run.phase,
      storageId: run.storage_id,
      peerId: run.peer_id,
      hlsRun: run.hls_run,
      pins: run.pins,
      batches: run.batches,
      capacityBefore: run.capacity_before,
      capacityAfter: run.capacity_after,
      createdAt: run.created_at.toISOString(),
      updatedAt: run.updated_at.toISOString(),
      pinTraversalComplete: run.phase === 'complete',
      consistentSnapshot: false,
      blocksVerified: false,
      referenceCoverage: 'selected-hls-inventory',
      deletionEnabled: false,
    };
  }
  private async page(id: string, after: string, limit: number) {
    if (
      typeof after !== 'string' ||
      (after && !pinCid(after)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('Invalid pin inventory page');
    const run = await this.run(id);
    if (run.phase !== 'complete')
      throw new ConflictException('Pin scan is incomplete; start a new run');
    return run;
  }
  async entries(id: string, after = '', limit = 100) {
    const run = await this.page(id, after, limit);
    const rows = await this.db.query(
      `WITH pins AS (
      SELECT cid,array_agg(type ORDER BY type) AS types FROM shorts_pin_inventory_entries
      WHERE network=$1 AND contract=$2 AND run_id=$3 AND cid>$4 GROUP BY cid ORDER BY cid LIMIT $5)
      SELECT p.*,
      (SELECT count(*)::text FROM shorts_hls_inventory_roots r WHERE r.network=$1 AND r.contract=$2 AND r.run_id=$6 AND r.source_cid=p.cid) AS "sourceReferences",
      (SELECT count(*)::text FROM shorts_hls_inventory_entries e WHERE e.network=$1 AND e.contract=$2 AND e.run_id=$6 AND e.cid=p.cid) AS "packageReferences",
      EXISTS(SELECT 1 FROM shorts_hls_inventory_roots r WHERE r.network=$1 AND r.contract=$2 AND r.run_id=$6 AND r.active_holds>0 AND
        (r.source_cid=p.cid OR EXISTS(SELECT 1 FROM shorts_hls_inventory_entries e WHERE e.network=r.network AND e.contract=r.contract AND e.run_id=r.run_id AND e.source_key=r.source_key AND e.cid=p.cid))) AS "observedHold"
      FROM pins p ORDER BY p.cid`,
      [...this.args(id), after, limit + 1, run.hls_run],
    );
    return {
      items: rows.slice(0, limit).map((row) => ({
        ...row,
        classification: row.observedHold
          ? 'held'
          : row.sourceReferences !== '0' || row.packageReferences !== '0'
            ? 'referenced'
            : 'unresolved',
        eligibleForDeletion: false,
      })),
      next: rows.length > limit ? rows[limit - 1].cid : null,
    };
  }
  async missing(id: string, after = '', limit = 100) {
    const run = await this.page(id, after, limit);
    const rows = await this.db.query(
      `WITH expected AS (
      SELECT source_cid AS cid FROM shorts_hls_inventory_roots WHERE network=$1 AND contract=$2 AND run_id=$6 AND source_cid IS NOT NULL
      UNION SELECT cid FROM shorts_hls_inventory_entries WHERE network=$1 AND contract=$2 AND run_id=$6)
      SELECT e.cid,EXISTS(SELECT 1 FROM shorts_pin_inventory_entries p WHERE p.network=$1 AND p.contract=$2 AND p.run_id=$3 AND p.cid=e.cid AND p.type='direct') AS "directOnly"
      FROM expected e WHERE e.cid>$4 AND NOT EXISTS(SELECT 1 FROM shorts_pin_inventory_entries p WHERE p.network=$1 AND p.contract=$2 AND p.run_id=$3 AND p.cid=e.cid AND p.type='recursive')
      ORDER BY e.cid LIMIT $5`,
      [...this.args(id), after, limit + 1, run.hls_run],
    );
    return {
      items: rows
        .slice(0, limit)
        .map((row) => ({ ...row, status: 'recursive-pin-not-observed' })),
      next: rows.length > limit ? rows[limit - 1].cid : null,
    };
  }
}
