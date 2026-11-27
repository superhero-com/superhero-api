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
  SHORTS_STORAGE_INVENTORY_CONFIG,
  StorageInventoryConfig,
} from './shorts-storage-inventory.config';
import {
  ShortsStorageListService,
  MultipartCursor,
} from './shorts-storage-list.service';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uploadHash = (value: MultipartCursor) =>
  hash([value.key, value.uploadId]);
const listingHash = (value: MultipartCursor | null) =>
  hash(['uploads', value ? [value.key, value.uploadId] : null]);

/** Optional provider-multipart metadata audit. No object/part bytes, encryption or abort authority. */
@Injectable()
export class ShortsMultipartInventoryService {
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    @Inject(SHORTS_STORAGE_INVENTORY_CONFIG)
    private readonly config: StorageInventoryConfig,
    private readonly storage: ShortsStorageListService,
  ) {}
  private args(id: string) {
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
    )
      throw new BadRequestException('Invalid multipart run ID');
    return [this.config.scope.network, this.config.scope.contract, id];
  }
  async verify() {
    const [role] = await this.db
      .query(`SELECT current_user=session_user AS direct,
      rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication OR
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) OR has_schema_privilege(current_schema(),'CREATE') AS privileged
      FROM pg_roles r WHERE rolname=current_user`);
    if (!role?.direct || role.privileged)
      throw new Error('Use a restricted multipart inventory login');
    for (const table of [
      'shorts_runtime',
      'shorts_multipart_inventory_runs',
      'shorts_multipart_inventory_uploads',
      'shorts_multipart_inventory_parts',
      'shorts_multipart_inventory_outcomes',
      'shorts_multipart_inventory_pages',
    ]) {
      const [access] = await this.db.query(
        `SELECT has_table_privilege($1,'SELECT') AS reads,has_table_privilege($1,'INSERT') AS inserts,
        has_any_column_privilege($1,'INSERT') AS any_insert,has_table_privilege($1,'UPDATE') AS updates,
        has_any_column_privilege($1,'UPDATE') AS any_update,has_table_privilege($1,'DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege($1,'REFERENCES') AS destructive,relrowsecurity AS filtered FROM pg_class WHERE oid=$1::regclass`,
        [table],
      );
      if (
        !access?.reads ||
        access.destructive ||
        access.filtered ||
        (table === 'shorts_runtime' ? access.any_insert : !access.inserts) ||
        (table === 'shorts_multipart_inventory_runs'
          ? !access.updates
          : access.any_update)
      )
        throw new Error('Invalid multipart inventory database grants');
    }
    const [runtime] = await this.db.query(
      'SELECT source_hash FROM shorts_runtime WHERE network=$1 AND contract=$2',
      [this.config.scope.network, this.config.scope.contract],
    );
    if (runtime?.source_hash !== this.config.sourceHash)
      throw new Error('Multipart deployment mismatch');
  }
  private check(row: any) {
    if (!row) throw new NotFoundException('Multipart inventory not found');
    if (
      row.source_hash !== this.config.sourceHash ||
      row.storage_id !== this.config.storageId ||
      row.object_prefix !== this.config.objectPrefix
    )
      throw new ConflictException('Multipart inventory configuration changed');
    return row;
  }
  private async run(id: string) {
    const [row] = await this.db.query(
      'SELECT * FROM shorts_multipart_inventory_runs WHERE network=$1 AND contract=$2 AND id=$3',
      this.args(id),
    );
    return this.check(row);
  }
  async start(id: string) {
    await this.db.query(
      `INSERT INTO shorts_multipart_inventory_runs(network,contract,id,source_hash,storage_id,object_prefix)
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
    const abort = AbortSignal.any([
      AbortSignal.timeout(30000),
      ...(signal ? [signal] : []),
    ]);
    abort.throwIfAborted();
    const args = this.args(id),
      run = await this.run(id);
    if (run.phase === 'complete') return this.status(id);
    const uploads =
      run.phase === 'uploads'
        ? await this.storage.multipartUploads(run.next_cursor, abort)
        : null;
    const [upload] =
      run.phase === 'parts'
        ? await this.db.query(
            `SELECT * FROM shorts_multipart_inventory_uploads
      WHERE network=$1 AND contract=$2 AND run_id=$3 AND identity>$4 ORDER BY identity LIMIT 1`,
            [...args, run.after_upload],
          )
        : [];
    const parts = upload
      ? await this.storage.multipartParts(
          { key: upload.object_key, uploadId: upload.upload_id },
          run.part_marker,
          abort,
        )
      : null;
    abort.throwIfAborted();
    await this.db.transaction(async (db) => {
      const [current] = await db.query(
        'SELECT * FROM shorts_multipart_inventory_runs WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        args,
      );
      this.check(current);
      abort.throwIfAborted();
      if (
        current.pages !== run.pages ||
        current.phase !== run.phase ||
        current.after_upload !== run.after_upload ||
        current.part_marker !== run.part_marker ||
        JSON.stringify(current.next_cursor) !== JSON.stringify(run.next_cursor)
      )
        throw new ConflictException(
          'Multipart inventory advanced; inspect saved status',
        );
      const cursor = uploads
        ? listingHash(run.next_cursor)
        : hash(['parts', run.after_upload, run.part_marker]);
      if (uploads) {
        if (uploads.next) {
          const [seen] = await db.query(
            'SELECT EXISTS(SELECT 1 FROM shorts_multipart_inventory_pages WHERE network=$1 AND contract=$2 AND run_id=$3 AND cursor_hash=$4) AS yes',
            [...args, listingHash(uploads.next)],
          );
          if (seen.yes || listingHash(uploads.next) === cursor)
            throw new ConflictException('Multipart listing cursor repeated');
        }
        const incoming = JSON.stringify(
          uploads.entries.map((row) => ({
            identity: uploadHash(row),
            object_key: row.key,
            upload_id: row.uploadId,
            initiated_at: row.initiatedAt,
          })),
        );
        const columns =
          'identity text,object_key text,upload_id text,initiated_at timestamptz';
        const [added] = await db.query(
          `WITH added AS (INSERT INTO shorts_multipart_inventory_uploads(network,contract,run_id,identity,object_key,upload_id,initiated_at)
          SELECT $1,$2,$3,x.* FROM jsonb_to_recordset($4::jsonb) AS x(${columns}) ON CONFLICT DO NOTHING RETURNING identity) SELECT count(*)::text AS n FROM added`,
          [...args, incoming],
        );
        const [comparison] = await db.query(
          `SELECT coalesce(bool_and(ROW(u.object_key,u.upload_id,u.initiated_at)=ROW(x.object_key,x.upload_id,x.initiated_at)),true) AS matches
          FROM jsonb_to_recordset($4::jsonb) AS x(${columns}) JOIN shorts_multipart_inventory_uploads u ON u.network=$1 AND u.contract=$2 AND u.run_id=$3 AND u.identity=x.identity`,
          [...args, incoming],
        );
        if (!comparison.matches)
          throw new ConflictException(
            'Multipart upload changed; start a new run',
          );
        await db.query(
          `UPDATE shorts_multipart_inventory_runs SET uploads=uploads+$4,next_cursor=$5,phase=$6
          WHERE network=$1 AND contract=$2 AND id=$3`,
          [
            ...args,
            added.n,
            uploads.next ? JSON.stringify(uploads.next) : null,
            uploads.next ? 'uploads' : 'parts',
          ],
        );
      } else if (parts) {
        const incoming = JSON.stringify(
          parts.entries.map((row) => ({
            part_number: row.number,
            bytes: row.bytes,
            modified_at: row.modifiedAt,
            etag: row.etag,
          })),
        );
        const columns =
          'part_number integer,bytes bigint,modified_at timestamptz,etag text';
        const [added] = await db.query(
          `WITH added AS (INSERT INTO shorts_multipart_inventory_parts(network,contract,run_id,upload_identity,part_number,bytes,modified_at,etag)
          SELECT $1,$2,$3,$4,x.* FROM jsonb_to_recordset($5::jsonb) AS x(${columns}) ON CONFLICT DO NOTHING RETURNING bytes)
          SELECT count(*)::text AS n,coalesce(sum(bytes),0)::text AS bytes FROM added`,
          [...args, upload.identity, incoming],
        );
        const [comparison] = await db.query(
          `SELECT coalesce(bool_and(ROW(p.bytes,p.modified_at,p.etag)=ROW(x.bytes,x.modified_at,x.etag)),true) AS matches
          FROM jsonb_to_recordset($5::jsonb) AS x(${columns}) JOIN shorts_multipart_inventory_parts p ON p.network=$1 AND p.contract=$2 AND p.run_id=$3 AND p.upload_identity=$4 AND p.part_number=x.part_number`,
          [...args, upload.identity, incoming],
        );
        if (!comparison.matches)
          throw new ConflictException(
            'Multipart part changed; start a new run',
          );
        if (parts.next === null)
          await db.query(
            `INSERT INTO shorts_multipart_inventory_outcomes(network,contract,run_id,upload_identity,unavailable)
          VALUES($1,$2,$3,$4,$5)`,
            [...args, upload.identity, parts.unavailable],
          );
        await db.query(
          `UPDATE shorts_multipart_inventory_runs SET parts=parts+$4,observed_bytes=observed_bytes+$5,
          examined=examined+$6,unavailable=unavailable+$7,after_upload=$8,part_marker=$9 WHERE network=$1 AND contract=$2 AND id=$3`,
          [
            ...args,
            added.n,
            added.bytes,
            parts.next === null ? 1 : 0,
            parts.unavailable ? 1 : 0,
            parts.next === null ? upload.identity : run.after_upload,
            parts.next ?? 0,
          ],
        );
      } else {
        await db.query(
          "UPDATE shorts_multipart_inventory_runs SET phase='complete' WHERE network=$1 AND contract=$2 AND id=$3",
          args,
        );
      }
      await db.query(
        'INSERT INTO shorts_multipart_inventory_pages(network,contract,run_id,page,cursor_hash) VALUES($1,$2,$3,$4,$5)',
        [...args, run.pages, cursor],
      );
      await db.query(
        'UPDATE shorts_multipart_inventory_runs SET pages=pages+1,updated_at=clock_timestamp() WHERE network=$1 AND contract=$2 AND id=$3',
        args,
      );
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
      objectPrefix: run.object_prefix,
      pages: run.pages,
      uploads: run.uploads,
      examinedUploads: run.examined,
      unavailableUploads: run.unavailable,
      parts: run.parts,
      observedPartBytes: run.observed_bytes,
      listingComplete: run.phase === 'complete',
      allListedUploadsObserved:
        run.phase === 'complete' &&
        run.examined === run.uploads &&
        run.unavailable === '0',
      // Provider pagination cannot establish whether the provider omitted uploads.
      inventoryCompleteness: 'unverified',
      consistentSnapshot: false,
      deletionEnabled: false,
      startedAt: run.created_at.toISOString(),
      updatedAt: run.updated_at.toISOString(),
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
      throw new BadRequestException('Invalid multipart inventory page');
  }
  async uploads(id: string, after = '', limit = 100) {
    this.page(after, limit);
    await this.run(id);
    const rows = await this.db.query(
      `WITH uploads AS (SELECT identity,object_key,upload_id,initiated_at FROM shorts_multipart_inventory_uploads
      WHERE network=$1 AND contract=$2 AND run_id=$3 AND identity>$4 ORDER BY identity LIMIT $5)
      SELECT u.identity,u.object_key AS key,u.upload_id AS "uploadId",u.initiated_at AS "initiatedAt",
      CASE WHEN o.unavailable THEN 'unavailable' WHEN o.unavailable=false THEN 'observed' ELSE 'pending' END AS status,
      (SELECT count(*)::text FROM shorts_multipart_inventory_parts p WHERE p.network=$1 AND p.contract=$2 AND p.run_id=$3 AND p.upload_identity=u.identity) AS parts,
      (SELECT coalesce(sum(bytes),0)::text FROM shorts_multipart_inventory_parts p WHERE p.network=$1 AND p.contract=$2 AND p.run_id=$3 AND p.upload_identity=u.identity) AS "observedBytes"
      FROM uploads u LEFT JOIN shorts_multipart_inventory_outcomes o ON o.network=$1 AND o.contract=$2 AND o.run_id=$3 AND o.upload_identity=u.identity ORDER BY u.identity`,
      [...this.args(id), after, limit + 1],
    );
    return {
      items: rows
        .slice(0, limit)
        .map((row) => ({ ...row, eligibleForAbort: false })),
      next: rows.length > limit ? rows[limit - 1].identity : null,
    };
  }
  async parts(id: string, upload: string, after = 0, limit = 100) {
    this.page(upload, limit);
    if (!upload || !Number.isSafeInteger(after) || after < 0 || after > 10000)
      throw new BadRequestException('Invalid part page');
    await this.run(id);
    const rows = await this.db.query(
      `SELECT part_number AS number,bytes::text,modified_at AS "modifiedAt",etag FROM shorts_multipart_inventory_parts
      WHERE network=$1 AND contract=$2 AND run_id=$3 AND upload_identity=$4 AND part_number>$5 ORDER BY part_number LIMIT $6`,
      [...this.args(id), upload, after, limit + 1],
    );
    return {
      items: rows.slice(0, limit),
      next: rows.length > limit ? rows[limit - 1].number : null,
    };
  }
}
