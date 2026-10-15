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
  RetentionConfig,
  SHORTS_RETENTION_CONFIG,
} from './shorts-retention.config';
import type { PrivateObjectRef } from './shorts-private-objects.service';

const SOURCES = [
  'shorts_runtime',
  'shorts_content',
  'shorts_ingestion',
  'shorts_upload_sessions',
  'shorts_upload_parts',
];
const id = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))
    throw new BadRequestException('Invalid resource ID');
  return value;
};
const uuid = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  )
    throw new BadRequestException('Invalid hold ID');
  return value;
};

/** Logical references and retention holds only. No object-store credentials or deletion authority. */
@Injectable()
export class ShortsRetentionService {
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    @Inject(SHORTS_RETENTION_CONFIG) private readonly config: RetentionConfig,
  ) {}
  private scope() {
    return [this.config.scope.network, this.config.scope.contract];
  }

  async verify(accessMode: 'manage-holds' | 'read-only' = 'manage-holds') {
    const [role] = await this.db
      .query(`SELECT current_user=session_user AS direct,
      rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS privileged,
      has_schema_privilege(current_schema(),'CREATE') AS creates_schema
      FROM pg_roles r WHERE rolname=current_user`);
    if (!role?.direct || role.privileged || role.creates_schema)
      throw new Error('Use a dedicated restricted retention login');
    for (const table of SOURCES) {
      const [access] = await this.db.query(
        `SELECT has_table_privilege($1,'SELECT') AS reads,
        has_table_privilege($1,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege($1,'INSERT,UPDATE,REFERENCES') AS writes,
        relrowsecurity AS filtered FROM pg_class WHERE oid=$1::regclass`,
        [table],
      );
      if (!access?.reads || access.writes || access.filtered)
        throw new Error(
          'Retention source access must be complete and read-only',
        );
    }
    const [access] = await this.db
      .query(`SELECT has_table_privilege('shorts_retention_holds','SELECT') AS reads,
      has_table_privilege('shorts_retention_holds','INSERT') AS inserts,
      has_table_privilege('shorts_retention_holds','UPDATE') AS updates,
      has_any_column_privilege('shorts_retention_holds','INSERT,UPDATE') AS writes,
      has_table_privilege('shorts_retention_holds','DELETE,TRUNCATE,REFERENCES,TRIGGER') AS destructive,
      relrowsecurity AS filtered FROM pg_class WHERE oid='shorts_retention_holds'::regclass`);
    if (
      !access?.reads ||
      (accessMode === 'manage-holds'
        ? !access.inserts || !access.updates
        : access.writes) ||
      access.destructive ||
      access.filtered
    )
      throw new Error(
        'Retention holds require restricted read/create/release access',
      );
    const [runtime] = await this.db.query(
      'SELECT source_hash FROM shorts_runtime WHERE network=$1 AND contract=$2',
      this.scope(),
    );
    if (runtime?.source_hash !== this.config.sourceHash)
      throw new Error('Retention deployment mismatch');
  }

  async hold(input: {
    id: string;
    resourceId: string;
    reason: string;
    reference: string;
  }) {
    const holdId = uuid(input?.id),
      resource = id(input?.resourceId);
    if (
      !['legal', 'safety', 'appeal', 'recovery'].includes(input.reason) ||
      typeof input.reference !== 'string' ||
      !/^[a-zA-Z0-9_.:/-]{1,120}$/.test(input.reference)
    )
      throw new BadRequestException(
        'Use a reason code and an internal case reference',
      );
    return this.db.transaction(async (db) => {
      await db.query(
        `INSERT INTO shorts_retention_holds(network,contract,id,resource_id,reason,reference)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [...this.scope(), holdId, resource, input.reason, input.reference],
      );
      const [row] = await db.query(
        'SELECT * FROM shorts_retention_holds WHERE network=$1 AND contract=$2 AND id=$3',
        [...this.scope(), holdId],
      );
      if (
        !row ||
        row.resource_id !== resource ||
        row.reason !== input.reason ||
        row.reference !== input.reference
      )
        throw new ConflictException(
          'Hold ID already belongs to another request',
        );
      return this.present(row);
    });
  }
  async release(holdId: string) {
    uuid(holdId);
    return this.db.transaction(async (db) => {
      const args = [...this.scope(), holdId];
      const [row] = await db.query(
        'SELECT * FROM shorts_retention_holds WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        args,
      );
      if (!row) throw new NotFoundException('Retention hold not found');
      if (row.released_at) return this.present(row);
      const [saved] = (
        await db.query(
          `UPDATE shorts_retention_holds SET released_by=current_user,released_at=clock_timestamp()
        WHERE network=$1 AND contract=$2 AND id=$3 RETURNING *`,
          args,
        )
      )[0];
      return this.present(saved);
    });
  }
  private present(row: any) {
    return {
      id: row.id,
      resourceId: row.resource_id,
      reason: row.reason,
      reference: row.reference,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      releasedBy: row.released_by,
      releasedAt: row.released_at?.toISOString() ?? null,
    };
  }

  async holds(resourceId: string, after = '', limit = 25) {
    id(resourceId);
    if (typeof after !== 'string')
      throw new BadRequestException('Invalid hold cursor');
    if (after) uuid(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new BadRequestException('Hold page size must be 1–50');
    const rows = await this.db.query(
      `SELECT * FROM shorts_retention_holds
      WHERE network=$1 AND contract=$2 AND resource_id=$3 AND ($4::uuid IS NULL OR id>$4::uuid)
      ORDER BY id LIMIT $5`,
      [...this.scope(), resourceId, after || null, limit + 1],
    );
    return {
      items: rows.slice(0, limit).map((row) => this.present(row)),
      next: rows.length > limit ? rows[limit - 1].id : null,
    };
  }

  async inventory(after = '', limit = 25) {
    if (typeof after !== 'string')
      throw new BadRequestException('Invalid inventory cursor');
    if (after) id(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new BadRequestException('Inventory page size must be 1–50');
    return this.db.transaction('REPEATABLE READ', async (db) => {
      const args = [...this.scope(), after, limit + 1];
      const roots = await db.query(
        `SELECT id FROM (
        SELECT id FROM shorts_content WHERE network=$1 AND contract=$2 AND id>$3
        UNION SELECT id FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id>$3
        UNION SELECT id FROM shorts_upload_sessions WHERE network=$1 AND contract=$2 AND id>$3
        UNION SELECT resource_id FROM shorts_retention_holds WHERE network=$1 AND contract=$2 AND resource_id>$3 AND released_at IS NULL
      ) roots ORDER BY id LIMIT $4`,
        args,
      );
      const ids = roots.slice(0, limit).map((row) => row.id);
      if (!ids.length) return { items: [], next: null, deletionEnabled: false };
      const keys = [...this.scope(), ids];
      const content = await db.query(
        'SELECT id,body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=ANY($3)',
        keys,
      );
      const ingestion = await db.query(
        'SELECT id,creator,status,input FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=ANY($3)',
        keys,
      );
      const uploads = await db.query(
        "SELECT id,state,to_jsonb(shorts_upload_sessions)->'direct_parts' AS direct_parts,expires_at>current_timestamp AS active FROM shorts_upload_sessions WHERE network=$1 AND contract=$2 AND id=ANY($3)",
        keys,
      );
      const parts = await db.query(
        'SELECT upload_id,object_ref FROM shorts_upload_parts WHERE network=$1 AND contract=$2 AND upload_id=ANY($3)',
        keys,
      );
      const holds = await db.query(
        'SELECT resource_id,count(*)::integer AS n FROM shorts_retention_holds WHERE network=$1 AND contract=$2 AND resource_id=ANY($3) AND released_at IS NULL GROUP BY resource_id',
        keys,
      );
      const items = ids.map((resourceId) => {
        const record = content.find((row) => row.id === resourceId)?.body;
        const job = ingestion.find((row) => row.id === resourceId),
          upload = uploads.find((row) => row.id === resourceId);
        const holdCount =
          holds.find((row) => row.resource_id === resourceId)?.n || 0;
        const objects = new Map<string, PrivateObjectRef>();
        const add = (ref?: PrivateObjectRef) => {
          if (ref) this.addReference(objects, ref);
        };
        parts
          .filter((row) => row.upload_id === resourceId)
          .forEach((row) => add(row.object_ref));
        for (const part of Object.values(upload?.direct_parts || {}) as {
          object: PrivateObjectRef;
        }[])
          add(part.object);
        add(job?.input?.manifest);
        add(record?.privateMedia?.source?.manifest);
        for (const ref of Object.values(record?.privateMedia?.files || {}))
          add(ref as PrivateObjectRef);
        const reasons: string[] = [];
        if (holdCount) reasons.push('explicit-hold');
        if (record?.appeal?.status === 'pending')
          reasons.push('pending-appeal');
        if (record?.reports > 0 || record?.reportDetails?.length)
          reasons.push('reports-without-disposition');
        if (job && ['queued', 'processing'].includes(job.status))
          reasons.push('active-preparation');
        if (upload?.active && upload.state !== 'enqueued')
          reasons.push('active-upload');
        if (record)
          reasons.push(
            record.publication === 'withdrawn'
              ? 'withdrawn-content-reference'
              : 'content-reference',
          );
        if (job) reasons.push('source-job-reference');
        // Source manifests are encrypted and may include parts absent from SQL (legacy import).
        const unresolvedManifests = !!(
          job?.input || record?.privateMedia?.source
        );
        if (unresolvedManifests)
          reasons.push('manifest-children-not-inventoried');
        const manifestSources = [
          job && { id: resourceId, creator: job.creator, input: job.input },
          record?.privateMedia?.source && {
            id: resourceId,
            creator: record.creator,
            input: record.privateMedia.source,
          },
        ]
          .filter(Boolean)
          .map((source) => ({
            id: source.id,
            creator: source.creator,
            input: {
              objectKey: source.input?.objectKey,
              manifest: source.input?.manifest,
              bytes: source.input?.bytes,
              sha256: source.input?.sha256,
            },
          }));
        const video = record?.files?.find((file) => file.name === 'video.mp4');
        return {
          id: resourceId,
          publication: record?.publication || null,
          preparation: job?.status || null,
          activeHolds: holdCount,
          retainReasons: reasons,
          cid: record?.cid || null,
          hlsSource: record?.cid
            ? {
                id: resourceId,
                cid: record.cid,
                file: video && {
                  name: video.name,
                  bytes: video.bytes,
                  sha256: video.sha256,
                },
              }
            : null,
          objects: [...objects.values()],
          manifestSources,
          knownPlaintextBytes: [...objects.values()].reduce(
            (n, ref) => n + ref.bytes,
            0,
          ),
          completePhysicalInventory: false,
          eligibleForDeletion: false,
        };
      });
      const cids = [...new Set(items.map((item) => item.cid).filter(Boolean))];
      const shared = cids.length
        ? await db.query(
            `SELECT body->>'cid' AS cid,count(*)::integer AS n
        FROM shorts_content WHERE body->>'cid'=ANY($1) GROUP BY body->>'cid'`,
            [cids],
          )
        : [];
      return {
        items: items.map((item) => ({
          ...item,
          cidReferences: shared.find((row) => row.cid === item.cid)?.n || 0,
        })),
        next: roots.length > limit ? ids.at(-1) : null,
        deletionEnabled: false,
      };
    });
  }
  private addReference(
    refs: Map<string, PrivateObjectRef>,
    ref: PrivateObjectRef,
  ) {
    const scopeHash = createHash('sha256')
      .update(JSON.stringify(this.scope()))
      .digest('hex');
    if (
      typeof ref.key !== 'string' ||
      !ref.key.startsWith(`${this.config.prefix}/${scopeHash}/`) ||
      !/^[a-zA-Z0-9_/-]{1,512}$/.test(ref.key) ||
      ref.key.includes('//') ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(ref.keyId) ||
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      !ref.key.endsWith(`/${ref.keyId}/${ref.sha256}`) ||
      !Number.isSafeInteger(ref.bytes) ||
      ref.bytes < 1 ||
      ref.bytes > 67108864
    )
      throw new Error('Cannot inventory an invalid private object reference');
    const previous = refs.get(ref.key);
    if (
      previous &&
      (previous.bytes !== ref.bytes ||
        previous.sha256 !== ref.sha256 ||
        previous.keyId !== ref.keyId)
    )
      throw new Error('Conflicting private object references');
    refs.set(ref.key, ref);
  }
}
