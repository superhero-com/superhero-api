import {
  shortsStorageScope,
  shortsStorageSourceHash,
} from './shorts-runtime-scope';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ShortsRecordsService } from './shorts-records.service';
import { ShortsMetadataService } from './shorts-metadata.service';
import {
  ShortsUploadRecordsService,
  SharedUpload,
  SHORTS_PART_BYTES,
} from './shorts-upload-records.service';
import { ShortsSourceService } from './shorts-source.service';
import { creatorContent } from './shorts-eligibility';
import type { UploadInput } from './shorts-uploads.service';

/** Hosted HTTP adapter. Never starts a decoder or a process-local upload queue. */
@Injectable()
export class ShortsHostedUploadsService {
  readonly shared = true;
  constructor(
    private readonly records: ShortsRecordsService,
    private readonly metadata: ShortsMetadataService,
    private readonly uploads: ShortsUploadRecordsService,
    private readonly source: ShortsSourceService,
  ) {}
  private scope() {
    if (!this.records.shared || !this.records.chain.state.contract)
      throw new ServiceUnavailableException(
        'Shared upload deployment is not initialized',
      );
    return shortsStorageScope(this.records.chain);
  }
  async initialize() {
    await this.metadata.verifyRuntime(
      this.scope(),
      shortsStorageSourceHash(this.records.chain),
    );
    await this.metadata.verifyHostedStorage(this.scope());
  }

  private async status(upload: SharedUpload) {
    const job =
      upload.state === 'enqueued'
        ? await this.metadata.getJob(this.scope(), upload.creator, upload.id)
        : undefined;
    const status =
      job?.status === 'cancelled' ? 'failed' : job?.status || 'uploading';
    const short =
      status === 'ready' ? await this.records.get(upload.id) : undefined;
    return {
      id: upload.id,
      parts: upload.parts.map((part) => part.index),
      partSize: SHORTS_PART_BYTES,
      transport: 'direct-s3-v1',
      expires: upload.expiresAt,
      complete: status === 'ready',
      status,
      attempts: job?.attempts || 0,
      error:
        status === 'failed'
          ? 'We could not prepare this video. Check the file and try again.'
          : undefined,
      video: short ? creatorContent(short) : undefined,
    };
  }
  async create(actor: string, input: UploadInput) {
    this.records.chain.address(actor);
    this.source.assertDirectUploadsConfigured();
    return this.status(
      await this.uploads.create(this.scope(), randomUUID(), actor, input),
    );
  }
  async get(actor: string, id: string) {
    return this.status(await this.uploads.get(this.scope(), id, actor));
  }
  prepareDirect(actor: string, id: string, index: number, sha256: string) {
    return this.source.prepareDirect(this.scope(), id, actor, index, sha256);
  }
  authorizeDirect(actor: string, id: string, index: number, checksum: string) {
    return this.source.authorizeDirect(
      this.scope(),
      id,
      actor,
      index,
      checksum,
    );
  }
  async completeDirect(actor: string, id: string, index: number) {
    await this.source.completeDirect(this.scope(), id, actor, index);
    return this.get(actor, id);
  }
  async part(
    actor: string,
    id: string,
    index: number,
    bytes: Buffer,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    await this.source.part(this.scope(), id, actor, index, bytes, signal);
    return this.get(actor, id);
  }
  async finish(actor: string, id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const job = await this.source.finish(this.scope(), id, actor, signal);
    signal?.throwIfAborted();
    if (job.status === 'failed')
      await this.metadata.retry(this.scope(), actor, id);
    return this.get(actor, id);
  }
  async enqueueFile(
    actor: string,
    input: Omit<UploadInput, 'bytes' | 'sha256'>,
    bytes: Buffer,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(bytes)) throw new Error('Choose a video');
    const upload = await this.create(actor, {
      ...input,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    for (
      let index = 0;
      index < Math.ceil(bytes.length / SHORTS_PART_BYTES);
      index++
    )
      await this.part(
        actor,
        upload.id,
        index,
        bytes.subarray(
          index * SHORTS_PART_BYTES,
          (index + 1) * SHORTS_PART_BYTES,
        ),
        signal,
      );
    return this.finish(actor, upload.id, signal);
  }
  async health() {
    const [jobs, workers, budget] = await Promise.all([
      this.metadata.health(this.scope()),
      this.metadata.workerCount(this.scope()),
      this.metadata.uploadBudget(this.scope()),
    ]);
    return {
      ...jobs.counts,
      oldestQueuedMs: jobs.oldestQueuedMs,
      workers,
      workerRunning: workers > 0,
      shared: true,
      budget,
    };
  }
}
