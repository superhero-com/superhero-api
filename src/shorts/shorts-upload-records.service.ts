import { ShortsDatabaseService } from './shorts-database.service';
import {
  Inject,
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ShortsMetadataService, ShortsScope } from './shorts-metadata.service';
import type { PrivateObjectRef } from './shorts-private-objects.service';
import type { UploadInput } from './shorts-uploads.service';
import { SHORTS_TOPICS } from './shorts-labels.service';

export const SHORTS_PART_BYTES = 1024 * 1024;
export interface SharedUpload {
  id: string;
  creator: string;
  input: UploadInput;
  state: 'uploading' | 'sealed' | 'enqueued';
  expiresAt: number;
  parts: { index: number; object: PrivateObjectRef }[];
}

/** Upload metadata and admission share PostgreSQL; byte IO stays outside transactions. */
@Injectable()
export class ShortsUploadRecordsService {
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    private readonly metadata: ShortsMetadataService,
  ) {}

  private params(scope: ShortsScope, id: string, creator: string) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
      !/^ak_[a-zA-Z0-9]{1,97}$/.test(creator)
    )
      throw new BadRequestException('Invalid upload identity');
    return [scope.network, scope.contract, id, creator];
  }
  validateInput(input: UploadInput) {
    if (
      !input ||
      input.rights !== true ||
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      input.title.length > 100 ||
      typeof input.topic !== 'string' ||
      !input.topic ||
      input.topic.length > 80 ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > 40 * SHORTS_PART_BYTES ||
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      !input.details ||
      typeof input.details !== 'object' ||
      Array.isArray(input.details) ||
      ['description', 'language', 'captions'].some(
        (key) =>
          input.details[key] !== undefined &&
          typeof input.details[key] !== 'string',
      ) ||
      ['synthetic', 'sponsored'].some(
        (key) =>
          input.details[key] !== undefined &&
          typeof input.details[key] !== 'boolean',
      ) ||
      JSON.stringify(input).length > 14000
    )
      throw new BadRequestException('Invalid upload details');
    if (
      !SHORTS_TOPICS.includes(input.topic) ||
      (input.details.description?.length || 0) > 1000 ||
      (input.details.captions?.length || 0) > 10000 ||
      !['und', 'en', 'ar', 'fr', 'es', 'de', 'zh'].includes(
        input.details.language || 'und',
      ) ||
      (input.details.captions &&
        (!input.details.captions.startsWith('WEBVTT') ||
          !input.details.captions.includes('-->') ||
          /<[^>]+>|STYLE|REGION|X-TIMESTAMP-MAP/.test(input.details.captions)))
    )
      throw new BadRequestException(
        'Invalid video topic, description, language or captions',
      );
  }
  private object(ref: PrivateObjectRef) {
    if (
      !ref ||
      typeof ref.key !== 'string' ||
      !/^[a-zA-Z0-9_/-]{1,512}$/.test(ref.key) ||
      ref.key.startsWith('/') ||
      ref.key.includes('//') ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(ref.keyId) ||
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      !ref.key.endsWith(`/${ref.keyId}/${ref.sha256}`) ||
      !Number.isSafeInteger(ref.bytes) ||
      ref.bytes < 1 ||
      ref.bytes > 64 * SHORTS_PART_BYTES
    )
      throw new BadRequestException('Invalid uploaded object');
  }
  private async lock(manager: EntityManager, params: string[]) {
    const [row] = await manager.query(
      'SELECT contract FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
      params.slice(0, 2),
    );
    if (!row)
      throw new ServiceUnavailableException(
        'Shorts deployment is not initialized',
      );
  }
  private async own(
    manager: EntityManager | DataSource,
    params: string[],
    locked = false,
  ) {
    if (locked)
      await manager.query(
        'SELECT id FROM shorts_upload_sessions WHERE network=$1 AND contract=$2 AND id=$3 AND creator=$4 FOR UPDATE',
        params,
      );
    const [row] = await manager.query(
      `SELECT *,expires_at<=clock_timestamp() AS expired FROM shorts_upload_sessions
      WHERE network=$1 AND contract=$2 AND id=$3 AND creator=$4`,
      params,
    );
    if (!row) throw new NotFoundException('Upload session not found');
    // Accepted jobs remain recoverable after the original upload window closes.
    if (row.expired && row.state !== 'enqueued')
      throw new GoneException('Upload expired. Start a new upload.');
    return row;
  }
  private async result(
    manager: EntityManager | DataSource,
    params: string[],
    row: any,
  ): Promise<SharedUpload> {
    const parts = await manager.query(
      'SELECT part,object_ref FROM shorts_upload_parts WHERE network=$1 AND contract=$2 AND upload_id=$3 ORDER BY part',
      params.slice(0, 3),
    );
    return {
      id: row.id,
      creator: row.creator,
      input: row.input,
      state: row.state,
      expiresAt: new Date(row.expires_at).getTime(),
      parts: parts.map((part) => ({
        index: part.part,
        object: part.object_ref,
      })),
    };
  }
  async get(scope: ShortsScope, id: string, creator: string) {
    const params = this.params(scope, id, creator);
    return this.result(this.db, params, await this.own(this.db, params));
  }
  async create(
    scope: ShortsScope,
    id: string,
    creator: string,
    input: UploadInput,
  ) {
    const params = this.params(scope, id, creator);
    this.validateInput(input);
    return this.db.transaction(async (manager) => {
      await this.lock(manager, params);
      const [existing] = await manager.query(
        'SELECT *,creator=$4 AND input=$5::jsonb AS matches FROM shorts_upload_sessions WHERE network=$1 AND contract=$2 AND id=$3',
        [...params, JSON.stringify(input)],
      );
      if (existing) {
        if (!existing.matches)
          throw new ConflictException('Upload identity already exists');
        return this.result(manager, params, await this.own(manager, params));
      }
      const [counts] = await manager.query(
        `SELECT count(*)::integer AS total, count(*) FILTER(WHERE creator=$3)::integer AS own,
        COALESCE(sum(bytes),0)::bigint AS total_bytes, COALESCE(sum(bytes) FILTER(WHERE creator=$3),0)::bigint AS own_bytes
        FROM shorts_upload_admission WHERE network=$1 AND contract=$2 AND created_at>now()-interval '1 hour'`,
        [params[0], params[1], creator],
      );
      if (
        counts.own >= 10 ||
        Number(counts.own_bytes) + input.bytes > 10 * 40 * SHORTS_PART_BYTES ||
        counts.total >= 100 ||
        Number(counts.total_bytes) + input.bytes > 100 * 40 * SHORTS_PART_BYTES
      )
        throw new HttpException(
          'Upload capacity reached. Try again later.',
          429,
        );
      const [active] = await manager.query(
        `SELECT count(*)::integer AS n FROM (
          (SELECT id FROM shorts_upload_sessions WHERE network=$1 AND contract=$2
            AND expires_at>now() ORDER BY expires_at LIMIT 100)
          UNION
          (SELECT j.id FROM shorts_ingestion j JOIN shorts_upload_sessions u USING(network,contract,id)
            WHERE j.network=$1 AND j.contract=$2 AND j.status IN ('queued','processing') LIMIT 100)
          LIMIT 100
        ) active`,
        params.slice(0, 2),
      );
      if (active.n >= 100)
        throw new ServiceUnavailableException(
          'Upload capacity reached. Try again later.',
        );
      const [row] = await manager.query(
        `INSERT INTO shorts_upload_sessions(network,contract,id,creator,input) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *`,
        [...params, JSON.stringify(input)],
      );
      await manager.query(
        `INSERT INTO shorts_upload_admission(network,contract,upload_id,creator,bytes) VALUES($1,$2,$3,$4,$5)`,
        [...params, input.bytes],
      );
      return this.result(manager, params, row);
    });
  }
  async part(
    scope: ShortsScope,
    id: string,
    creator: string,
    index: number,
    object: PrivateObjectRef,
  ) {
    const params = this.params(scope, id, creator);
    this.object(object);
    if (!Number.isSafeInteger(index) || index < 0 || index > 39)
      throw new BadRequestException('Invalid upload part');
    return this.db.transaction(async (manager) => {
      await this.lock(manager, params);
      const row = await this.own(manager, params, true);
      const expected = Math.min(
        SHORTS_PART_BYTES,
        row.input.bytes - index * SHORTS_PART_BYTES,
      );
      if (expected < 1 || expected !== object.bytes)
        throw new BadRequestException('Incorrect upload part size');
      const [existing] = await manager.query(
        'SELECT object_ref FROM shorts_upload_parts WHERE network=$1 AND contract=$2 AND upload_id=$3 AND part=$4',
        [...params.slice(0, 3), index],
      );
      if (existing) {
        // Same bytes are idempotent, including a retry after encryption-key rotation.
        if (
          existing.object_ref.sha256 !== object.sha256 ||
          existing.object_ref.bytes !== object.bytes
        )
          throw new ConflictException(
            'This upload part already contains different bytes',
          );
        return existing.object_ref as PrivateObjectRef;
      }
      if (row.state !== 'uploading')
        throw new ConflictException('Upload is already being prepared');
      await manager.query(
        'INSERT INTO shorts_upload_parts(network,contract,upload_id,part,object_ref) VALUES($1,$2,$3,$4,$5::jsonb)',
        [...params.slice(0, 3), index, JSON.stringify(object)],
      );
      return object;
    });
  }
  async seal(scope: ShortsScope, id: string, creator: string) {
    const params = this.params(scope, id, creator);
    return this.db.transaction(async (manager) => {
      await this.lock(manager, params);
      const row = await this.own(manager, params, true);
      const upload = await this.result(manager, params, row);
      if (
        upload.parts.length !==
        Math.ceil(upload.input.bytes / SHORTS_PART_BYTES)
      )
        throw new ConflictException('Upload all video parts first');
      if (row.state === 'uploading') {
        await manager.query(
          "UPDATE shorts_upload_sessions SET state='sealed' WHERE network=$1 AND contract=$2 AND id=$3",
          params.slice(0, 3),
        );
        upload.state = 'sealed';
      }
      return upload;
    });
  }
  async enqueue(
    scope: ShortsScope,
    id: string,
    creator: string,
    manifest: PrivateObjectRef,
  ) {
    const params = this.params(scope, id, creator);
    this.object(manifest);
    return this.db.transaction(async (manager) => {
      await this.lock(manager, params);
      const row = await this.own(manager, params, true);
      if (row.state === 'uploading')
        throw new ConflictException('Seal the upload before preparation');
      if (row.state === 'enqueued')
        return this.metadata.getJob(scope, creator, id, manager);
      const job = await this.metadata.enqueue(
        scope,
        id,
        creator,
        {
          objectKey: manifest.key,
          manifest,
          sha256: row.input.sha256,
          bytes: row.input.bytes,
          title: row.input.title,
          topic: row.input.topic,
          details: row.input.details,
        },
        manager,
      );
      await manager.query(
        "UPDATE shorts_upload_sessions SET state='enqueued' WHERE network=$1 AND contract=$2 AND id=$3",
        params.slice(0, 3),
      );
      return job;
    });
  }
}
