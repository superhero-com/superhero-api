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
import {
  StorageInventoryConfig,
  SHORTS_STORAGE_INVENTORY_CONFIG,
} from './shorts-storage-inventory.config';
import {
  StorageCursor,
  ShortsStorageListService,
} from './shorts-storage-list.service';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cursorHash = (cursor: StorageCursor | null) =>
  hash(cursor ? [cursor.key, cursor.version] : null);
const validId = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  )
    throw new BadRequestException('Invalid inventory run ID');
};

@Injectable()
export class ShortsStorageInventoryService {
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    @Inject(SHORTS_STORAGE_INVENTORY_CONFIG)
    private readonly config: StorageInventoryConfig,
    private readonly storage: ShortsStorageListService,
  ) {}
  private args(id: string) {
    validId(id);
    return [this.config.scope.network, this.config.scope.contract, id];
  }
  async verify() {
    const [role] = await this.db
      .query(`SELECT current_user=session_user AS direct,
      rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication OR
        EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) OR has_schema_privilege(current_schema(),'CREATE') AS privileged
      FROM pg_roles r WHERE rolname=current_user`);
    if (!role?.direct || role.privileged)
      throw new Error('Use a dedicated restricted storage inventory login');
    const [source] = await this.db
      .query(`SELECT has_table_privilege('shorts_runtime','SELECT') AS reads,
      has_table_privilege('shorts_runtime','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_any_column_privilege('shorts_runtime','INSERT,UPDATE,REFERENCES') AS writes,
      relrowsecurity AS filtered FROM pg_class WHERE oid='shorts_runtime'::regclass`);
    if (!source?.reads || source.writes || source.filtered)
      throw new Error('Inventory runtime must be read-only and unfiltered');
    for (const table of [
      'shorts_storage_inventory_runs',
      'shorts_storage_inventory_pages',
      'shorts_storage_inventory_objects',
    ]) {
      const [access] = await this.db.query(
        `SELECT has_table_privilege($1,'SELECT') AS reads,
        has_table_privilege($1,'INSERT') AS inserts,
        has_table_privilege($1,'UPDATE') AS updates,
        has_any_column_privilege($1,'UPDATE') AS column_updates,
        has_table_privilege($1,'DELETE,TRUNCATE,REFERENCES,TRIGGER') AS destroys,
        relrowsecurity AS filtered FROM pg_class WHERE oid=$1::regclass`,
        [table],
      );
      if (
        !access?.reads ||
        !access.inserts ||
        (table.endsWith('_runs') ? !access.updates : access.column_updates) ||
        access.destroys ||
        access.filtered
      )
        throw new Error('Invalid storage inventory database grants');
    }
    const [runtime] = await this.db.query(
      'SELECT source_hash FROM shorts_runtime WHERE network=$1 AND contract=$2',
      [this.config.scope.network, this.config.scope.contract],
    );
    if (runtime?.source_hash !== this.config.sourceHash)
      throw new Error('Storage inventory deployment mismatch');
  }
  private checkRun(row: any) {
    if (!row) throw new NotFoundException('Inventory run not found');
    if (
      row.source_hash !== this.config.sourceHash ||
      row.storage_id !== this.config.storageId ||
      row.object_prefix !== this.config.objectPrefix
    )
      throw new ConflictException(
        'Inventory run belongs to a different storage configuration',
      );
    return row;
  }
  async start(id: string) {
    await this.db.query(
      `INSERT INTO shorts_storage_inventory_runs(network,contract,id,source_hash,storage_id,object_prefix)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        ...this.args(id),
        this.config.sourceHash,
        this.config.storageId,
        this.config.objectPrefix,
      ],
    );
    return this.status(id);
  }
  async step(id: string, signal?: AbortSignal) {
    const args = this.args(id);
    const abort = AbortSignal.any([
      AbortSignal.timeout(30000),
      ...(signal ? [signal] : []),
    ]);
    abort.throwIfAborted();
    const [row] = await this.db.query(
      'SELECT * FROM shorts_storage_inventory_runs WHERE network=$1 AND contract=$2 AND id=$3',
      args,
    );
    this.checkRun(row);
    if (row.complete) return this.status(id);
    const page = await this.storage.page(row.next_cursor, abort);
    abort.throwIfAborted();
    await this.db.transaction(async (db) => {
      const [current] = await db.query(
        'SELECT * FROM shorts_storage_inventory_runs WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        args,
      );
      this.checkRun(current);
      abort.throwIfAborted();
      if (
        current.page !== row.page ||
        current.complete ||
        JSON.stringify(current.next_cursor) !== JSON.stringify(row.next_cursor)
      )
        throw new ConflictException(
          'Another inventory process advanced this run; read its saved status',
        );
      if (page.next) {
        const [seen] = await db.query(
          `SELECT EXISTS(SELECT 1 FROM shorts_storage_inventory_pages
          WHERE network=$1 AND contract=$2 AND run_id=$3 AND cursor_hash=$4) AS yes`,
          [...args, cursorHash(page.next)],
        );
        if (seen.yes || cursorHash(page.next) === cursorHash(row.next_cursor))
          throw new Error('Storage listing repeated a saved cursor');
      }
      const incoming = JSON.stringify(
        page.entries.map((entry) => ({
          identity: hash([entry.key, entry.version, entry.deleted]),
          object_key: entry.key,
          version_id: entry.version,
          deleted: entry.deleted,
          latest: entry.latest,
          bytes: String(entry.bytes),
          modified_at: entry.modifiedAt,
        })),
      );
      const columns =
        'identity text,object_key text,version_id text,deleted boolean,latest boolean,bytes bigint,modified_at timestamptz';
      const [added] = await db.query(
        `WITH inserted AS (
        INSERT INTO shorts_storage_inventory_objects(network,contract,run_id,identity,object_key,version_id,deleted,latest,bytes,modified_at)
        SELECT $1,$2,$3,x.* FROM jsonb_to_recordset($4::jsonb) AS x(${columns})
        ON CONFLICT DO NOTHING RETURNING deleted,latest,bytes
      ) SELECT count(*)::text AS entries,count(*) FILTER(WHERE deleted)::text AS markers,
        coalesce(sum(bytes),0)::text AS bytes,coalesce(sum(bytes) FILTER(WHERE NOT deleted AND latest),0)::text AS current
        FROM inserted`,
        [...args, incoming],
      );
      const [comparison] = await db.query(
        `SELECT coalesce(bool_and(
        ROW(o.object_key,o.version_id,o.deleted,o.latest,o.bytes,o.modified_at)=ROW(x.object_key,x.version_id,x.deleted,x.latest,x.bytes,x.modified_at)),true) AS matches
        FROM jsonb_to_recordset($4::jsonb) AS x(${columns})
        JOIN shorts_storage_inventory_objects o ON o.network=$1 AND o.contract=$2 AND o.run_id=$3 AND o.identity=x.identity`,
        [...args, incoming],
      );
      if (!comparison.matches)
        throw new ConflictException(
          'Storage changed while listing; preserve this run and start a new inventory',
        );
      abort.throwIfAborted();
      await db.query(
        `INSERT INTO shorts_storage_inventory_pages(network,contract,run_id,page,cursor_hash) VALUES($1,$2,$3,$4,$5)`,
        [...args, row.page, cursorHash(row.next_cursor)],
      );
      await db.query(
        `UPDATE shorts_storage_inventory_runs SET page=page+1,next_cursor=$4::jsonb,complete=$5,updated_at=clock_timestamp(),
          entries=entries+$6::bigint,delete_markers=delete_markers+$7::bigint,stored_bytes=stored_bytes+$8::numeric,current_bytes=current_bytes+$9::numeric
        WHERE network=$1 AND contract=$2 AND id=$3`,
        [
          ...args,
          page.next ? JSON.stringify(page.next) : null,
          !page.next,
          added.entries,
          added.markers,
          added.bytes,
          added.current,
        ],
      );
    });
    return this.status(id);
  }
  async status(id: string) {
    return this.db.transaction('REPEATABLE READ', async (db) => {
      const args = this.args(id);
      const [row] = await db.query(
        'SELECT * FROM shorts_storage_inventory_runs WHERE network=$1 AND contract=$2 AND id=$3',
        args,
      );
      this.checkRun(row);
      return {
        id,
        storageId: row.storage_id,
        objectPrefix: row.object_prefix,
        listingComplete: row.complete,
        pages: row.page,
        startedAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        entries: row.entries,
        deleteMarkers: row.delete_markers,
        storedBytes: row.stored_bytes,
        currentBytes: row.current_bytes,
        referenceReconciliationComplete: false,
        deletionEnabled: false,
      };
    });
  }
  async objects(id: string, after = '', limit = 100) {
    if (
      typeof after !== 'string' ||
      (after && !/^[a-f0-9]{64}$/.test(after)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('Invalid storage inventory page');
    const args = this.args(id);
    const [run] = await this.db.query(
      'SELECT * FROM shorts_storage_inventory_runs WHERE network=$1 AND contract=$2 AND id=$3',
      args,
    );
    this.checkRun(run);
    const rows = await this.db.query(
      `SELECT identity,object_key AS key,version_id AS version,deleted,latest,bytes::text,modified_at AS "modifiedAt"
      FROM shorts_storage_inventory_objects WHERE network=$1 AND contract=$2 AND run_id=$3 AND identity>$4 ORDER BY identity LIMIT $5`,
      [...args, after, limit + 1],
    );
    return {
      items: rows.slice(0, limit),
      next: rows.length > limit ? rows[limit - 1].identity : null,
      deletionEnabled: false,
    };
  }
}
