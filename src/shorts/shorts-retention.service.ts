import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import {
  RetentionConfig,
  SHORTS_RETENTION_CONFIG,
} from './shorts-retention.config';
import type { PrivateObjectRef } from './shorts-private-objects.service';
import type { ShortRecord } from './shorts.types';
import {
  validateOriginalContent,
  derivedFiles,
} from './shorts-original-content';
import { shortsPlaybackDescriptor } from './shorts-playback-descriptor';
import { sourceKey, validateSourcePackage } from './hls-protocol/hls-package';
import { SHORTS_ORIGINAL_HARD_LIMIT } from './shorts-media-file';

const SOURCES = [
  'shorts_runtime',
  'shorts_content',
  'shorts_ingestion',
  'shorts_upload_sessions',
  'shorts_upload_parts',
  'shorts_delivery_packages',
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
  private async privateRetirementSchema(db: DataSource | EntityManager) {
    const [{ present }] = await db.query(
      "SELECT to_regclass('shorts_private_input_retirements') IS NOT NULL AS present",
    );
    return present === true;
  }
  private async generationSchema(db: DataSource | EntityManager) {
    // During reader-first rollout an old schema cannot contain generation jobs.
    // A half-applied or inconsistent schema is never interpreted as no references.
    const [schema] =
      await db.query(`SELECT to_regclass('shorts_delivery_generations') IS NOT NULL AS outputs,
      EXISTS(SELECT FROM pg_attribute WHERE attrelid='shorts_ingestion'::regclass AND attname='delivery_short_id' AND NOT attisdropped) AS jobs,
      to_regclass('shorts_delivery_staging') IS NOT NULL AS staging,
      EXISTS(SELECT FROM pg_attribute WHERE attrelid='shorts_delivery_packages'::regclass AND attname='generation_job_id' AND NOT attisdropped) AS delivery_jobs`);
    if (
      schema.outputs !== schema.jobs ||
      ((schema.delivery_jobs || schema.staging) && !schema.outputs)
    )
      throw new Error('Incomplete delivery generation schema');
    return {
      generations: schema.outputs === true,
      staging: schema.staging === true,
      deliveryRoot: schema.delivery_jobs ? 'generation_job_id' : 'short_id',
    };
  }

  async verify(accessMode: 'manage-holds' | 'read-only' = 'manage-holds') {
    const [role] = await this.db
      .query(`SELECT current_user=session_user AS direct,
      rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS privileged,
      has_schema_privilege(current_schema(),'CREATE') AS creates_schema
      FROM pg_roles r WHERE rolname=current_user`);
    if (!role?.direct || role.privileged || role.creates_schema)
      throw new Error('Use a dedicated restricted retention login');
    const { generations: generationSchema, staging } =
      await this.generationSchema(this.db);
    const privateRetirements = await this.privateRetirementSchema(this.db);
    for (const table of [
      ...SOURCES,
      ...(generationSchema ? ['shorts_delivery_generations'] : []),
      ...(staging ? ['shorts_delivery_staging'] : []),
      ...(privateRetirements ? ['shorts_private_input_retirements'] : []),
    ]) {
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
      const {
        generations: generationSchema,
        deliveryRoot,
        staging,
      } = await this.generationSchema(db);
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
      const generations = generationSchema
        ? await db.query(
            'SELECT job_id AS id,short_id,body FROM shorts_delivery_generations WHERE network=$1 AND contract=$2 AND job_id=ANY($3)',
            keys,
          )
        : [];
      content.push(...generations);
      const stagedSources = staging
        ? await db.query(
            'SELECT job_id,state,manifest FROM shorts_delivery_staging WHERE network=$1 AND contract=$2 AND job_id=ANY($3)',
            keys,
          )
        : [];
      const retiredSources = (await this.privateRetirementSchema(db))
        ? await db.query(
            `SELECT resource_id,source_manifest FROM shorts_private_input_retirements
              WHERE network=$1 AND contract=$2 AND resource_id=ANY($3)`,
            keys,
          )
        : [];
      const deliveries = await db.query(
        `SELECT short_id,source_key,prepared,${deliveryRoot} AS resource_id
        FROM shorts_delivery_packages d WHERE network=$1 AND contract=$2
        AND ${deliveryRoot}=ANY($3)`,
        keys,
      );
      const ingestion = await db.query(
        "SELECT id,creator,status,input,to_jsonb(shorts_ingestion)->>'delivery_short_id' AS delivery_short_id FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=ANY($3)",
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
      const targetIds: string[] = [
        ...new Set(
          ingestion.map((row) => row.delivery_short_id).filter(Boolean),
        ),
      ] as string[];
      const targets = targetIds.length
        ? await db.query(
            'SELECT id,body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=ANY($3)',
            [...this.scope(), targetIds],
          )
        : [];
      const holds = await db.query(
        'SELECT resource_id,count(*)::integer AS n FROM shorts_retention_holds WHERE network=$1 AND contract=$2 AND resource_id=ANY($3) AND released_at IS NULL GROUP BY resource_id',
        [...this.scope(), [...ids, ...targetIds]],
      );
      const items = ids.map((resourceId) => {
        const record = content.find((row) => row.id === resourceId)?.body;
        const job = ingestion.find((row) => row.id === resourceId),
          upload = uploads.find((row) => row.id === resourceId);
        const staged = stagedSources.find((row) => row.job_id === resourceId);
        const target = job?.delivery_short_id
          ? targets.find((row) => row.id === job.delivery_short_id)?.body
          : undefined;
        if (job?.delivery_short_id && (!generationSchema || !target))
          throw new Error('Delivery generation target missing');
        const holdCount =
          (holds.find((row) => row.resource_id === resourceId)?.n || 0) +
          (target
            ? holds.find((row) => row.resource_id === target.id)?.n || 0
            : 0);
        const objects = new Map<string, PrivateObjectRef>();
        const original = record ? validateOriginalContent(record) : false;
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
        if (staged) {
          const bytes = Buffer.from(staged.manifest),
            manifest = JSON.parse(staged.manifest);
          if (
            !job ||
            !job.delivery_short_id ||
            bytes.length !== job.input?.manifest?.bytes ||
            createHash('sha256').update(bytes).digest('hex') !==
              job.input?.manifest?.sha256 ||
            manifest.id !== job.id ||
            manifest.creator !== job.creator ||
            manifest.bytes !== job.input.bytes ||
            manifest.sha256 !== job.input.sha256 ||
            !Array.isArray(manifest.parts)
          )
            throw new Error('Invalid reserved source manifest');
          for (const part of manifest.parts) add(part.object);
        }
        for (const [name, ref] of Object.entries(
          record?.privateMedia?.files || {},
        )) {
          const object = ref as PrivateObjectRef;
          const file = record.files.find((file) => file.name === name);
          if (
            !file ||
            file.bytes !== object?.bytes ||
            file.sha256 !== object?.sha256
          )
            throw new Error('Private output differs from original derivative');
          this.addReference(objects, object, SHORTS_ORIGINAL_HARD_LIMIT);
        }
        const reasons: string[] = [];
        if (staged && staged.state !== 'ready')
          reasons.push('original-restaging-reference');
        if (holdCount) reasons.push('explicit-hold');
        if (
          record?.appeal?.status === 'pending' ||
          target?.appeal?.status === 'pending'
        )
          reasons.push('pending-appeal');
        if (
          record?.reports > 0 ||
          record?.reportDetails?.length ||
          target?.reports > 0 ||
          target?.reportDetails?.length
        )
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
        if (target) reasons.push('delivery-generation-reference');
        const unresolvedManifests = !!(
          (!staged && job?.input) ||
          record?.privateMedia?.source
        );
        if (unresolvedManifests)
          reasons.push('manifest-children-not-inventoried');
        const manifestSources = [
          job &&
            !staged && {
              id: resourceId,
              creator: job.creator,
              input: job.input,
            },
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
              processingProfile: source.input?.processingProfile,
              acceptedMaxBytes: source.input?.acceptedMaxBytes,
            },
          }));
        // The receipt preserves the authenticated document even after its encrypted
        // object is reclaimed. Keep the edges; readers must still revalidate every
        // claimant's current source identity and frozen admission policy.
        const retiredDocuments: string[] = [
          ...new Set<string>(
            retiredSources
              .filter((row) => row.resource_id === resourceId)
              .map((row) => row.source_manifest),
          ),
        ];
        if (retiredDocuments.length > 1)
          throw new Error('Retired source manifests disagree');
        const retiredManifest = retiredDocuments[0];
        if (
          retiredManifest !== undefined &&
          manifestSources.some(
            (source) => source.input.processingProfile !== 'original-h264-v1',
          )
        )
          throw new Error('Retired source is no longer an original upload');
        const pins: {
          kind: 'original' | 'inputs' | 'assets' | 'hls';
          cid: string;
          bytes: number | null;
        }[] = record?.cid
          ? [
              {
                kind: 'original',
                cid: record.cid,
                bytes: Number.isSafeInteger(record.bytes) ? record.bytes : null,
              },
            ]
          : [];
        if (original)
          for (const kind of ['inputs', 'assets'] as const)
            pins.push({
              kind,
              cid:
                kind === 'inputs'
                  ? record.derivatives.cid
                  : record.derivatives.assetsCid,
              bytes: derivedFiles<ShortRecord['files'][number]>(
                record.files,
                kind,
              ).reduce((sum, file) => sum + file.bytes, 0),
            });
        for (const delivery of deliveries.filter(
          (row) => row.resource_id === resourceId,
        )) {
          if (delivery.short_id !== (target?.id || resourceId))
            throw new Error('Acknowledged delivery target changed');
          const descriptor = {
            ...shortsPlaybackDescriptor(record, this.config.scope),
            id: delivery.short_id,
          };
          if (sourceKey(descriptor) !== delivery.source_key)
            throw new Error('Acknowledged delivery source changed');
          const prepared = validateSourcePackage(descriptor, delivery.prepared);
          pins.push({
            kind: 'hls',
            cid: prepared.cid,
            bytes: prepared.files.reduce((sum, file) => sum + file.bytes, 0),
          });
        }
        return {
          id: resourceId,
          ...(target ? { deliveryOf: target.id } : {}),
          publication: target?.publication || record?.publication || null,
          preparation: job?.status || null,
          activeHolds: holdCount,
          retainReasons: reasons,
          cid: record?.cid || null,
          pins,
          hlsSource: original
            ? {
                ...shortsPlaybackDescriptor(record, this.config.scope),
                id: target?.id || record.id,
              }
            : null,
          objects: [...objects.values()],
          manifestSources: manifestSources.map((source) => ({
            ...source,
            ...(retiredManifest !== undefined ? { retiredManifest } : {}),
          })),
          knownPlaintextBytes: [...objects.values()].reduce(
            (n, ref) => n + ref.bytes,
            0,
          ),
          completePhysicalInventory: false,
          eligibleForDeletion: false,
        };
      });
      const cids = [
        ...new Set(items.flatMap((item) => item.pins.map((pin) => pin.cid))),
      ];
      const shared = cids.length
        ? await db.query(
            `SELECT cid,count(DISTINCT (network,contract,id))::integer AS n FROM (
        SELECT s.network,s.contract,s.id,c.cid
        FROM shorts_content s CROSS JOIN LATERAL (VALUES(s.body->>'cid'),(s.body->'derivatives'->>'cid'),(s.body->'derivatives'->>'assetsCid')) c(cid)
        WHERE c.cid=ANY($1)
        UNION ALL SELECT network,contract,${deliveryRoot},prepared->>'cid'
          FROM shorts_delivery_packages d WHERE prepared->>'cid'=ANY($1)
        ${
          generationSchema
            ? `UNION ALL SELECT g.network,g.contract,g.job_id,c.cid FROM shorts_delivery_generations g
          CROSS JOIN LATERAL (VALUES(g.body->>'cid'),(g.body->'derivatives'->>'cid'),(g.body->'derivatives'->>'assetsCid')) c(cid) WHERE c.cid=ANY($1)`
            : ''
        }
        ) all_refs GROUP BY cid`,
            [cids],
          )
        : [];
      return {
        items: items.map((item) => ({
          ...item,
          cidReferences: shared.find((row) => row.cid === item.cid)?.n || 0,
          pins: item.pins.map((pin) => ({
            ...pin,
            references: shared.find((row) => row.cid === pin.cid)?.n || 0,
          })),
        })),
        next: roots.length > limit ? ids.at(-1) : null,
        deletionEnabled: false,
      };
    });
  }
  private addReference(
    refs: Map<string, PrivateObjectRef>,
    ref: PrivateObjectRef,
    maxBytes = 67108864,
  ) {
    const scopeHash = createHash('sha256')
      .update(JSON.stringify(this.scope()))
      .digest('hex');
    if (
      !ref ||
      typeof ref.key !== 'string' ||
      !ref.key.startsWith(`${this.config.prefix}/${scopeHash}/`) ||
      !/^[a-zA-Z0-9_/-]{1,512}$/.test(ref.key) ||
      ref.key.includes('//') ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(ref.keyId) ||
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      !ref.key.endsWith(`/${ref.keyId}/${ref.sha256}`) ||
      !Number.isSafeInteger(ref.bytes) ||
      ref.bytes < 1 ||
      ref.bytes > maxBytes
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
