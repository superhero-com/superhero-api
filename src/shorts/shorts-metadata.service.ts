import { ShortsDatabaseService } from './shorts-database.service';
import {
  Inject,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { ShortRecord } from './shorts.types';
import type { PrivateObjectRef } from './shorts-private-objects.service';
import {
  ShortsUploadBudgetLimits,
  validateUploadBudget,
} from './shorts-upload-budget';

export interface ShortsScope {
  network: 'ae_uat' | 'ae_mainnet';
  contract: string;
}
export interface StoredShort {
  record: ShortRecord;
  revision: string;
}
export interface IngestionInput {
  /** Private durable object reference; never a browser-supplied fetch URL. */
  objectKey: string;
  /** Encrypted source manifest, when the upload uses private shared storage. */
  manifest?: PrivateObjectRef;
  sha256: string;
  bytes: number;
  title: string;
  topic: string;
  details: Record<string, unknown>;
}
export interface IngestionJob {
  id: string;
  creator: string;
  input: IngestionInput;
  status: 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled';
  attempts: number;
  fence: string;
  leaseToken?: string;
  leaseUntil?: Date;
  errorCode?: string;
  resultId?: string;
}
export interface IngestionClaim {
  id: string;
  fence: string;
  leaseToken: string;
}

/** Shared metadata only: no private files, signing keys or process-wide snapshot. */
@Injectable()
export class ShortsMetadataService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}

  async verifyHostedStorage(scope: ShortsScope) {
    await this.verifyUploadBudget(scope);
    const params = this.scope(scope);
    const [runtime] = await this.db.query(
      `SELECT r.legacy_hash,c.completed_at,c.fingerprint FROM shorts_runtime r
      LEFT JOIN shorts_legacy_cutovers c USING(network,contract)
      WHERE r.network=$1 AND r.contract=$2`,
      params,
    );
    if (
      !runtime ||
      ((runtime.legacy_hash || runtime.fingerprint) && !runtime.completed_at)
    )
      throw new ServiceUnavailableException(
        'Complete the offline Shorts legacy migration before starting the hosted API',
      );
    const [missing] = await this.db.query(
      `SELECT 1 FROM shorts_content WHERE network=$1 AND contract=$2
      AND (body->'privateMedia' IS NULL OR body->'privateMedia'='null'::jsonb) LIMIT 1`,
      params,
    );
    if (missing)
      throw new ServiceUnavailableException(
        'Hosted content is missing private shared media; complete its migration',
      );
  }

  async verifyUploadBudget(scope: ShortsScope) {
    const [{ count }] = await this.db
      .query(`SELECT count(*)::integer AS count FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname=current_schema() AND p.pronamespace=n.oid AND p.prosecdef AND t.tgenabled IN ('O','A')
      AND ((c.relname IN ('shorts_upload_sessions','shorts_ingestion','shorts_content')
        AND t.tgname='shorts_reserve_upload' AND p.proname='shorts_reserve_upload' AND t.tgtype=5)
        OR (c.relname='shorts_runtime' AND t.tgname='shorts_upload_budget_initialize'
        AND p.proname='shorts_upload_budget_initialize' AND t.tgtype=5))`);
    if (count !== 4)
      throw new ServiceUnavailableException(
        'Apply and enable the Shorts upload-budget migration before opening uploads',
      );
    await this.uploadBudget(scope);
  }

  async uploadBudget(scope: ShortsScope) {
    const [row] = await this.db.query(
      'SELECT max_uploads,max_source_bytes,used_uploads,used_source_bytes FROM shorts_upload_budgets WHERE network=$1 AND contract=$2',
      this.scope(scope),
    );
    if (!row)
      throw new ServiceUnavailableException('Upload budget is not initialized');
    return {
      maxUploads: String(row.max_uploads),
      maxSourceBytes: String(row.max_source_bytes),
      usedUploads: String(row.used_uploads),
      usedSourceBytes: String(row.used_source_bytes),
      exhausted:
        BigInt(row.used_uploads) >= BigInt(row.max_uploads) ||
        BigInt(row.used_source_bytes) >= BigInt(row.max_source_bytes),
    };
  }

  /** Migration/setup login only. Runtime API roles receive SELECT, never UPDATE. */
  async configureUploadBudget(
    scope: ShortsScope,
    limits: ShortsUploadBudgetLimits,
  ) {
    validateUploadBudget(limits);
    const rows = await this.updatedRows(
      this.db,
      `UPDATE shorts_upload_budgets SET max_uploads=$3,max_source_bytes=$4,updated_at=clock_timestamp()
       WHERE network=$1 AND contract=$2 RETURNING contract`,
      [...this.scope(scope), limits.uploads, limits.sourceBytes],
    );
    if (!rows.length)
      throw new ServiceUnavailableException('Upload budget is not initialized');
  }

  private scope(scope: ShortsScope) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract)
    )
      throw new BadRequestException('Invalid Shorts deployment scope');
    return [scope.network, scope.contract];
  }
  private identity(id: string, creator?: string) {
    if (
      typeof id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
      (creator !== undefined &&
        (typeof creator !== 'string' ||
          !/^ak_[a-zA-Z0-9]{1,97}$/.test(creator)))
    )
      throw new BadRequestException('Invalid Shorts identity');
  }
  private record(record: ShortRecord) {
    this.identity(record?.id, record?.creator);
    if (
      !record.creator ||
      !record.cid ||
      !Number.isSafeInteger(record.createdAt) ||
      record.createdAt < 0 ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 1 ||
      !['pending', 'approved', 'rejected'].includes(record.moderation)
    )
      throw new BadRequestException('Invalid prepared Short');
    return JSON.stringify(record);
  }
  // TypeORM's PostgreSQL driver returns [rows, affectedCount] for UPDATE,
  // including WITH ... UPDATE. Keep callers on the actual returned rows.
  private async updatedRows(
    db: DataSource | EntityManager,
    sql: string,
    values: unknown[],
  ) {
    const [rows] = await db.query(sql, values);
    if (!Array.isArray(rows))
      throw new Error('Unexpected PostgreSQL update result');
    return rows;
  }
  private stored(row: any): StoredShort {
    return { record: row.body, revision: String(row.revision) };
  }
  private job(row: any): IngestionJob {
    return {
      id: row.id,
      creator: row.creator,
      input: row.input,
      status: row.status,
      attempts: row.attempts,
      fence: String(row.fence),
      leaseToken: row.lease_token ?? undefined,
      leaseUntil: row.lease_until ?? undefined,
      errorCode: row.error_code ?? undefined,
      resultId: row.result_id ?? undefined,
    };
  }
  private lease(ms: number) {
    if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 300000)
      throw new BadRequestException(
        'Worker leases must be between 1000 and 300000 ms',
      );
    return ms;
  }
  private claimIdentity(claim: IngestionClaim) {
    this.identity(claim.id);
    if (
      !/^[1-9][0-9]{0,18}$/.test(claim.fence) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        claim.leaseToken,
      )
    )
      throw new BadRequestException('Invalid preparation claim');
    return [claim.id, claim.fence, claim.leaseToken];
  }

  /** Bind verified deployment identity and shared admission limits; never silently change them. */
  async initialize(
    scope: ShortsScope,
    sourceHash: string,
    maxPending = 8,
    maxCreatorPending = 2,
  ) {
    const params = this.scope(scope);
    if (
      !/^[a-f0-9]{64}$/.test(sourceHash) ||
      !Number.isSafeInteger(maxPending) ||
      maxPending < 1 ||
      maxPending > 10000 ||
      !Number.isSafeInteger(maxCreatorPending) ||
      maxCreatorPending < 1 ||
      maxCreatorPending > maxPending
    )
      throw new BadRequestException('Invalid shared Shorts configuration');
    return this.db.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO shorts_runtime(network,contract,source_hash,max_pending,max_creator_pending)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [...params, sourceHash, maxPending, maxCreatorPending],
      );
      const [row] = await manager.query(
        'SELECT * FROM shorts_runtime WHERE network=$1 AND contract=$2',
        params,
      );
      if (
        row.source_hash !== sourceHash ||
        row.max_pending !== maxPending ||
        row.max_creator_pending !== maxCreatorPending
      )
        throw new ConflictException(
          'Shared Shorts deployment configuration does not match',
        );
    });
  }
  async get(scope: ShortsScope, id: string): Promise<StoredShort> {
    this.identity(id);
    const [row] = await this.db.query(
      'SELECT body,revision FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3',
      [...this.scope(scope), id],
    );
    if (!row) throw new NotFoundException('Short not found');
    return this.stored(row);
  }
  /** One-time explicit import from the verified local registry. Never overwrite shared records. */
  async importLegacy(
    scope: ShortsScope,
    records: ShortRecord[],
    fingerprint: string,
    allowImport: boolean,
  ) {
    const params = this.scope(scope);
    if (!/^[a-f0-9]{64}$/.test(fingerprint))
      throw new BadRequestException('Invalid migration identity');
    return this.db.transaction(async (manager) => {
      const [runtime] = await manager.query(
        'SELECT legacy_hash FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
        params,
      );
      if (!runtime)
        throw new ServiceUnavailableException(
          'Shorts deployment is not initialized',
        );
      if (runtime.legacy_hash === fingerprint) return;
      if (!records.length && !runtime.legacy_hash) return;
      if (runtime.legacy_hash || !allowImport)
        throw new ConflictException(
          'Legacy Shorts content needs an explicit matching migration',
        );
      const [count] = await manager.query(
        'SELECT count(*)::integer AS n FROM shorts_content WHERE network=$1 AND contract=$2',
        params,
      );
      if (count.n)
        throw new ConflictException(
          'Cannot import over existing shared Shorts content',
        );
      for (const record of records)
        await manager.query(
          `INSERT INTO shorts_content(network,contract,id,creator,created_at,body)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
          [
            ...params,
            record.id,
            record.creator,
            record.createdAt,
            this.record(record),
          ],
        );
      await manager.query(
        'UPDATE shorts_runtime SET legacy_hash=$3 WHERE network=$1 AND contract=$2',
        [...params, fingerprint],
      );
    });
  }
  /** Trusted API preparation during migration; isolated workers use fenced complete(). */
  async insertDraft(
    scope: ShortsScope,
    record: ShortRecord,
    capacity?: number,
  ): Promise<StoredShort> {
    const body = this.record(record);
    if (
      record.publication ||
      record.moderation === 'approved' ||
      (capacity !== undefined &&
        (!Number.isSafeInteger(capacity) || capacity < 1))
    )
      throw new BadRequestException(
        'Only unapproved private drafts can be registered',
      );
    const params = this.scope(scope);
    return this.db.transaction(async (manager) => {
      const [runtime] = await manager.query(
        'SELECT contract FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
        params,
      );
      if (!runtime)
        throw new ServiceUnavailableException(
          'Shorts deployment is not initialized',
        );
      const [existing] = await manager.query(
        'SELECT body,revision FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3',
        [...params, record.id],
      );
      if (existing) {
        if (
          existing.body.creator !== record.creator ||
          existing.body.cid !== record.cid ||
          existing.body.bytes !== record.bytes
        )
          throw new ConflictException('Upload identity mismatch');
        return this.stored(existing);
      }
      if (capacity !== undefined) {
        // Optional stricter caller bound for offline tooling. The database's
        // retained-upload reservation is always authoritative when inserting.
        const [count] = await manager.query(
          'SELECT count(*)::integer AS n FROM (SELECT 1 FROM shorts_content WHERE network=$1 AND contract=$2 LIMIT $3) bounded',
          [...params, capacity],
        );
        if (count.n >= capacity)
          throw new ServiceUnavailableException('Video capacity reached');
      }
      const [row] = await manager.query(
        `INSERT INTO shorts_content(network,contract,id,creator,created_at,body)
        VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING body,revision`,
        [...params, record.id, record.creator, record.createdAt, body],
      );
      return this.stored(row);
    });
  }
  async page(
    scope: ShortsScope,
    options: {
      creator?: string;
      limit?: number;
      after?: { at: number; id: string };
      publishedOnly?: boolean;
    } = {},
  ) {
    const limit = options.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException('Page size must be between 1 and 100');
    if (options.creator) this.identity('page', options.creator);
    if (options.after) {
      this.identity(options.after.id);
      if (!Number.isSafeInteger(options.after.at) || options.after.at < 0)
        throw new BadRequestException('Invalid cursor');
    }
    const rows = await this.db.query(
      `SELECT body,revision,created_at,id FROM shorts_content
      WHERE network=$1 AND contract=$2 AND ($3::text IS NULL OR creator=$3)
      ${options.publishedOnly ? "AND body->>'publication'='published' AND body->>'moderation'='approved'" : ''}
      AND ($4::bigint IS NULL OR (created_at,id)<($4,$5))
      ORDER BY created_at DESC,id DESC LIMIT $6`,
      [
        ...this.scope(scope),
        options.creator ?? null,
        options.after?.at ?? null,
        options.after?.id ?? null,
        limit + 1,
      ],
    );
    const records = rows.slice(0, limit);
    const last = records[records.length - 1];
    return {
      items: records.map((row) => this.stored(row)),
      next:
        rows.length > limit
          ? { at: Number(last.created_at), id: String(last.id) }
          : undefined,
    };
  }
  /** Compare-and-swap for results computed outside the database transaction. */
  async replace(
    scope: ShortsScope,
    record: ShortRecord,
    expectedRevision: string,
  ) {
    const body = this.record(record);
    if (!/^[1-9][0-9]{0,18}$/.test(expectedRevision))
      throw new BadRequestException('Invalid content revision');
    const rows = await this.updatedRows(
      this.db,
      `UPDATE shorts_content SET body=$5::jsonb,revision=revision+1
      WHERE network=$1 AND contract=$2 AND id=$3 AND revision=$4::bigint
      AND creator=$6 AND created_at=$7 AND body->>'cid'=$8
      AND body->'bytes'=$5::jsonb->'bytes' AND body->'files'=$5::jsonb->'files' AND body->'duration'=$5::jsonb->'duration'
      AND (body->'privateMedia') IS NOT DISTINCT FROM ($5::jsonb->'privateMedia')
      RETURNING body,revision`,
      [
        ...this.scope(scope),
        record.id,
        expectedRevision,
        body,
        record.creator,
        record.createdAt,
        record.cid,
      ],
    );
    if (!rows.length)
      throw new ConflictException(
        'Short changed; read it again before updating',
      );
    return this.stored(rows[0]);
  }
  /** Short synchronous metadata changes run against the latest locked row. No network work here. */
  async change(
    scope: ShortsScope,
    id: string,
    update: (record: ShortRecord) => void,
  ): Promise<StoredShort> {
    this.identity(id);
    const params = [...this.scope(scope), id];
    return this.db.transaction(async (manager) => {
      const [row] = await manager.query(
        'SELECT * FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        params,
      );
      if (!row) throw new NotFoundException('Short not found');
      const record: ShortRecord = row.body;
      const immutable = JSON.stringify([
        record.cid,
        record.bytes,
        record.duration,
        record.files,
        record.privateMedia,
      ]);
      const result: unknown = update(record);
      if (result && typeof (result as any).then === 'function')
        throw new Error('Metadata changes must be synchronous');
      const body = this.record(record);
      if (
        record.id !== id ||
        record.creator !== row.creator ||
        record.createdAt !== Number(row.created_at) ||
        JSON.stringify([
          record.cid,
          record.bytes,
          record.duration,
          record.files,
          record.privateMedia,
        ]) !== immutable
      )
        throw new ConflictException('Content identity is immutable');
      const [saved] = await this.updatedRows(
        manager,
        'UPDATE shorts_content SET body=$4::jsonb,revision=revision+1 WHERE network=$1 AND contract=$2 AND id=$3 RETURNING body,revision',
        [...params, body],
      );
      return this.stored(saved);
    });
  }

  private async admission(
    manager: EntityManager,
    scope: ShortsScope,
    creator: string,
  ) {
    const params = this.scope(scope);
    // The scope row serializes admission counts across all API/worker instances.
    const [limits] = await manager.query(
      'SELECT * FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
      params,
    );
    if (!limits)
      throw new ServiceUnavailableException(
        'Shorts deployment is not initialized',
      );
    // The INSERT trigger reserves durable ingress count/bytes. Retried jobs
    // retain that reservation; here we only admit bounded preparation work.
    const [counts] = await manager.query(
      `SELECT count(*)::integer AS total,
      count(*) FILTER(WHERE creator=$3)::integer AS own FROM shorts_ingestion
      WHERE network=$1 AND contract=$2 AND status IN ('queued','processing')`,
      [...params, creator],
    );
    if (
      counts.total >= limits.max_pending ||
      counts.own >= limits.max_creator_pending
    )
      throw new ServiceUnavailableException(
        'Video preparation is busy; please try again shortly',
      );
  }
  async enqueue(
    scope: ShortsScope,
    id: string,
    creator: string,
    input: IngestionInput,
    transaction?: EntityManager,
  ): Promise<IngestionJob> {
    this.identity(id, creator);
    if (
      !input ||
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > 40 * 1024 * 1024 ||
      !/^[a-zA-Z0-9_/-]{1,512}$/.test(input.objectKey) ||
      input.objectKey.startsWith('/') ||
      input.objectKey.includes('//') ||
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      input.title.length > 100 ||
      typeof input.topic !== 'string' ||
      !input.details ||
      typeof input.details !== 'object' ||
      Array.isArray(input.details) ||
      JSON.stringify(input).length > 16000
    )
      throw new BadRequestException('Invalid preparation input');
    if (
      transaction &&
      (!transaction.queryRunner?.isTransactionActive ||
        transaction.connection !== this.db)
    )
      throw new Error(
        'Upload enqueue requires an active transaction from the same database',
      );
    const enqueue = async (manager: EntityManager) => {
      // Lock before the duplicate lookup as well, so concurrent retries are idempotent.
      const params = this.scope(scope);
      await manager.query(
        'SELECT contract FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
        params,
      );
      const [existing] = await manager.query(
        'SELECT *,creator=$4 AND input=$5::jsonb AS matches FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=$3',
        [...params, id, creator, JSON.stringify(input)],
      );
      if (existing) {
        // JSONB equality treats metadata key order as insignificant.
        if (!existing.matches)
          throw new ConflictException(
            'Upload identity already exists with different input',
          );
        return this.job(existing);
      }
      await this.admission(manager, scope, creator);
      const [row] = await manager.query(
        `INSERT INTO shorts_ingestion(network,contract,id,creator,input)
        VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *`,
        [...params, id, creator, JSON.stringify(input)],
      );
      return this.job(row);
    };
    return transaction ? enqueue(transaction) : this.db.transaction(enqueue);
  }
  async getJob(
    scope: ShortsScope,
    creator: string,
    id: string,
    transaction?: EntityManager,
  ) {
    this.identity(id, creator);
    const [row] = await (transaction || this.db).query(
      'SELECT * FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=$3 AND creator=$4',
      [...this.scope(scope), id, creator],
    );
    if (!row) throw new NotFoundException('Upload not found');
    return this.job(row);
  }
  async claim(
    scope: ShortsScope,
    leaseMs = 120000,
  ): Promise<IngestionJob | undefined> {
    this.lease(leaseMs);
    const params = this.scope(scope);
    return this.db.transaction(async (manager) => {
      // Bound recovery work; SKIP LOCKED keeps another worker's transaction independent.
      await manager.query(
        `UPDATE shorts_ingestion SET status='failed',lease_token=NULL,lease_until=NULL,
        error_code='attempts_exhausted',updated_at=clock_timestamp()
        WHERE (network,contract,id) IN (SELECT network,contract,id FROM shorts_ingestion
          WHERE network=$1 AND contract=$2 AND status='processing' AND lease_until<=clock_timestamp() AND attempts>=3
          ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED)`,
        params,
      );
      const [row] = await this.updatedRows(
        manager,
        `WITH candidate AS (
        SELECT id FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND attempts<3
        AND ((status='queued' AND (error_code IS DISTINCT FROM 'capacity_wait' OR updated_at<=clock_timestamp()-interval '5 seconds')) OR (status='processing' AND lease_until<=clock_timestamp()))
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE shorts_ingestion j SET status='processing',attempts=attempts+1,fence=fence+1,
        lease_token=$3::uuid,lease_until=clock_timestamp()+$4::integer*interval '1 millisecond',updated_at=clock_timestamp(),error_code=NULL
        FROM candidate c WHERE j.network=$1 AND j.contract=$2 AND j.id=c.id RETURNING j.*`,
        [...params, randomUUID(), leaseMs],
      );
      return row ? this.job(row) : undefined;
    });
  }
  async heartbeat(scope: ShortsScope, claim: IngestionClaim, leaseMs = 120000) {
    const params = [
      ...this.scope(scope),
      ...this.claimIdentity(claim),
      this.lease(leaseMs),
    ];
    return this.db.transaction(async (manager) => {
      // Check expiry after acquiring the lock. An UPDATE's predicate can have
      // been evaluated before waiting on an unchanged, locked row.
      await manager.query(
        'SELECT id FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        params.slice(0, 3),
      );
      const rows = await this.updatedRows(
        manager,
        `UPDATE shorts_ingestion SET lease_until=clock_timestamp()+$6::integer*interval '1 millisecond',updated_at=clock_timestamp()
      WHERE network=$1 AND contract=$2 AND id=$3 AND fence=$4::bigint AND lease_token=$5::uuid
      AND status='processing' AND lease_until>clock_timestamp() RETURNING id`,
        params,
      );
      return rows.length === 1;
    });
  }
  async complete(
    scope: ShortsScope,
    claim: IngestionClaim,
    record: ShortRecord,
  ): Promise<StoredShort> {
    const body = this.record(record);
    const params = [...this.scope(scope), ...this.claimIdentity(claim)];
    return this.db.transaction(async (manager) => {
      const [job] = await manager.query(
        `SELECT * FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=$3
        AND fence=$4::bigint AND lease_token=$5::uuid AND status='processing' AND lease_until>clock_timestamp() FOR UPDATE`,
        params,
      );
      if (!job)
        throw new ConflictException(
          'Preparation claim expired or was replaced',
        );
      if (
        record.id !== job.id ||
        record.creator !== job.creator ||
        record.publication ||
        record.moderation === 'approved' ||
        (job.input.manifest &&
          (!record.privateMedia ||
            record.privateMedia.fence !== claim.fence ||
            JSON.stringify(record.privateMedia.source) !==
              JSON.stringify(job.input)))
      )
        throw new ConflictException(
          'Preparation may only register its own unapproved private draft',
        );
      if (
        job.input.manifest &&
        (record.privateMedia.version !== 1 ||
          !record.privateMedia.files ||
          Object.keys(record.privateMedia.files).length !==
            record.files.length ||
          record.files.some((file) => {
            const ref = record.privateMedia.files[file.name];
            return (
              !ref ||
              ref.bytes !== file.bytes ||
              ref.sha256 !== file.sha256 ||
              !ref.key.includes(
                `/${record.id}/attempt/${claim.fence}/${file.name.replaceAll('.', '-')}/`,
              ) ||
              !ref.key.endsWith(`/${ref.keyId}/${ref.sha256}`)
            );
          }))
      )
        throw new ConflictException(
          'Prepared object references do not match this worker attempt',
        );
      await manager.query(
        `INSERT INTO shorts_content(network,contract,id,creator,created_at,body)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          ...this.scope(scope),
          record.id,
          record.creator,
          record.createdAt,
          body,
        ],
      );
      const rows = await this.updatedRows(
        manager,
        `UPDATE shorts_ingestion SET status='ready',result_id=id,lease_token=NULL,lease_until=NULL,
        updated_at=clock_timestamp(),error_code=NULL WHERE network=$1 AND contract=$2 AND id=$3
        AND fence=$4::bigint AND lease_token=$5::uuid AND lease_until>clock_timestamp() RETURNING id`,
        params,
      );
      if (!rows.length)
        throw new ConflictException('Preparation claim expired before commit');
      return { record: JSON.parse(body), revision: '1' };
    });
  }
  async fail(scope: ShortsScope, claim: IngestionClaim) {
    const params = [...this.scope(scope), ...this.claimIdentity(claim)];
    return this.db.transaction(async (manager) => {
      await manager.query(
        'SELECT id FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        params.slice(0, 3),
      );
      const rows = await this.updatedRows(
        manager,
        `UPDATE shorts_ingestion SET status='failed',lease_token=NULL,lease_until=NULL,
      error_code='preparation_failed',updated_at=clock_timestamp() WHERE network=$1 AND contract=$2 AND id=$3
      AND fence=$4::bigint AND lease_token=$5::uuid AND status='processing' AND lease_until>clock_timestamp() RETURNING id`,
        params,
      );
      return rows.length === 1;
    });
  }
  async retry(scope: ShortsScope, creator: string, id: string) {
    this.identity(id, creator);
    return this.db.transaction(async (manager) => {
      const params = [...this.scope(scope), id, creator];
      // Keep the same lock order as admission before locking the job.
      await manager.query(
        'SELECT contract FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
        this.scope(scope),
      );
      const [row] = await manager.query(
        'SELECT * FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=$3 AND creator=$4 FOR UPDATE',
        params,
      );
      if (!row) throw new NotFoundException('Upload not found');
      if (['queued', 'processing', 'ready'].includes(row.status))
        return this.job(row);
      if (row.status !== 'failed' || row.attempts >= 3)
        throw new ConflictException('Start a new upload');
      await this.admission(manager, scope, creator);
      const [job] = await this.updatedRows(
        manager,
        "UPDATE shorts_ingestion SET status='queued',error_code=NULL,updated_at=clock_timestamp() WHERE network=$1 AND contract=$2 AND id=$3 AND creator=$4 RETURNING *",
        params,
      );
      return this.job(job);
    });
  }
  async cancel(scope: ShortsScope, creator: string, id: string) {
    this.identity(id, creator);
    const params = [...this.scope(scope), id, creator];
    return this.db.transaction(async (manager) => {
      const [row] = await manager.query(
        'SELECT * FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=$3 AND creator=$4 FOR UPDATE',
        params,
      );
      if (!row) throw new NotFoundException('Upload not found');
      if (row.status === 'cancelled') return;
      if (row.status !== 'queued')
        throw new ConflictException(
          'Preparation has started; this job cannot be cancelled',
        );
      await manager.query(
        "UPDATE shorts_ingestion SET status='cancelled',updated_at=clock_timestamp() WHERE network=$1 AND contract=$2 AND id=$3 AND creator=$4",
        params,
      );
    });
  }
  async verifyRuntime(scope: ShortsScope, sourceHash: string) {
    const [row] = await this.db.query(
      'SELECT source_hash FROM shorts_runtime WHERE network=$1 AND contract=$2',
      this.scope(scope),
    );
    if (!row || row.source_hash !== sourceHash)
      throw new ConflictException(
        'Worker deployment does not match the initialized API',
      );
  }
  async workerPulse(scope: ShortsScope, id: string) {
    const params = [...this.scope(scope), id];
    await this.db.query(
      `INSERT INTO shorts_media_workers(network,contract,id) VALUES($1,$2,$3::uuid)
      ON CONFLICT(network,contract,id) DO UPDATE SET heartbeat_at=clock_timestamp()`,
      params,
    );
    await this.db.query(
      "DELETE FROM shorts_media_workers WHERE network=$1 AND contract=$2 AND heartbeat_at<clock_timestamp()-interval '1 day'",
      params.slice(0, 2),
    );
  }
  async workerStop(scope: ShortsScope, id: string) {
    await this.db.query(
      'DELETE FROM shorts_media_workers WHERE network=$1 AND contract=$2 AND id=$3::uuid',
      [...this.scope(scope), id],
    );
  }
  async workerCount(scope: ShortsScope) {
    const [row] = await this.db.query(
      "SELECT count(*)::integer AS n FROM shorts_media_workers WHERE network=$1 AND contract=$2 AND heartbeat_at>clock_timestamp()-interval '30 seconds'",
      this.scope(scope),
    );
    return row.n as number;
  }
  async health(scope: ShortsScope) {
    const rows = await this.db.query(
      `SELECT status,count(*)::integer AS count,
      max(extract(epoch FROM clock_timestamp()-created_at)*1000)::float8 AS oldest_ms
      FROM shorts_ingestion WHERE network=$1 AND contract=$2 GROUP BY status`,
      this.scope(scope),
    );
    return {
      counts: Object.fromEntries(rows.map((row) => [row.status, row.count])),
      oldestQueuedMs: Math.max(
        0,
        Number(rows.find((row) => row.status === 'queued')?.oldest_ms || 0),
      ),
    };
  }
}
