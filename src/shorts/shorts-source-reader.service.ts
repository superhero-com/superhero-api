import {
  shortsSourceLimit,
  SHORTS_BUFFERED_SOURCE_MAX_BYTES,
  SHORTS_SOURCE_MANIFEST_BYTES,
} from './shorts-upload-policy';
import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import type { ShortsMediaFile } from './shorts-media-file';
import type {
  IngestionJob,
  IngestionInput,
  ShortsScope,
} from './shorts-metadata.service';
import {
  PrivateObjectRef,
  ShortsPrivateObjectsService,
} from './shorts-private-objects.service';
import { SHORTS_PART_BYTES } from './shorts-upload-records.service';

export interface PrivateSourceIdentity {
  id: string;
  creator: string;
  input: Pick<
    IngestionInput,
    | 'objectKey'
    | 'manifest'
    | 'sha256'
    | 'bytes'
    | 'processingProfile'
    | 'acceptedMaxBytes'
  >;
}

/** Reads accepted encrypted source manifests without any database authority. */
@Injectable()
export class ShortsSourceReaderService {
  constructor(protected readonly objects: ShortsPrivateObjectsService) {}
  async manifestParts(
    scope: ShortsScope,
    job: PrivateSourceIdentity,
    signal?: AbortSignal,
  ): Promise<PrivateObjectRef[]> {
    return (await this.manifestDocument(scope, job, signal)).parts;
  }
  /** Authenticated, validated source metadata for durable reference retirement. */
  async manifestDocument(
    scope: ShortsScope,
    job: PrivateSourceIdentity,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; parts: PrivateObjectRef[] }> {
    signal?.throwIfAborted();
    this.assertManifest(job);
    const bytes = await this.objects.get(scope, job.input.manifest, signal);
    return this.parseManifest(scope, job, bytes, signal);
  }

  /** Revalidates a retained plaintext manifest without requiring its encrypted copy. */
  manifestPartsFromDocument(
    scope: ShortsScope,
    job: PrivateSourceIdentity,
    bytes: Buffer,
    signal?: AbortSignal,
  ): PrivateObjectRef[] {
    signal?.throwIfAborted();
    this.assertManifest(job);
    this.objects.validateReference(scope, job.input.manifest);
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length !== job.input.manifest.bytes ||
      createHash('sha256').update(bytes).digest('hex') !==
        job.input.manifest.sha256
    )
      throw new BadRequestException(
        'Retained source manifest identity mismatch',
      );
    return this.parseManifest(scope, job, bytes, signal).parts;
  }

  private assertManifest(job: PrivateSourceIdentity) {
    const input = job.input;
    if (
      !input ||
      !input.manifest ||
      input.manifest.key !== input.objectKey ||
      input.manifest.bytes > SHORTS_SOURCE_MANIFEST_BYTES
    )
      throw new BadRequestException('Invalid private source manifest');
  }

  private parseManifest(
    scope: ShortsScope,
    job: PrivateSourceIdentity,
    manifestBytes: Buffer,
    signal?: AbortSignal,
  ) {
    const input = job.input;
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid private source manifest');
    }
    if (
      !manifest ||
      manifest.version !== 1 ||
      manifest.id !== job.id ||
      manifest.creator !== job.creator ||
      manifest.sha256 !== input.sha256 ||
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      manifest.bytes !== input.bytes ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > shortsSourceLimit(input) ||
      !Array.isArray(manifest.parts) ||
      manifest.parts.length !== Math.ceil(input.bytes / SHORTS_PART_BYTES)
    )
      throw new BadRequestException(
        'Private source does not match the accepted upload',
      );
    const parts: PrivateObjectRef[] = [];
    for (const [index, part] of manifest.parts.entries()) {
      if (
        part?.index !== index ||
        part.object?.bytes !==
          Math.min(SHORTS_PART_BYTES, input.bytes - index * SHORTS_PART_BYTES)
      )
        throw new BadRequestException('Invalid private source parts');
      this.objects.validateReference(scope, part.object);
      parts.push({
        key: part.object.key,
        keyId: part.object.keyId,
        bytes: part.object.bytes,
        sha256: part.object.sha256,
      });
    }
    signal?.throwIfAborted();
    return { bytes: manifestBytes, parts };
  }
  async read(
    scope: ShortsScope,
    job: Pick<IngestionJob, 'id' | 'creator' | 'input'>,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (job.input.bytes > SHORTS_BUFFERED_SOURCE_MAX_BYTES)
      throw new BadRequestException(
        'Large originals require the bounded file reader',
      );
    const parts = await this.manifestParts(scope, job, signal);
    const input = job.input;
    const chunks: Buffer[] = [];
    for (const ref of parts)
      chunks.push(await this.objects.get(scope, ref, signal));
    const source = Buffer.concat(chunks);
    if (
      source.length !== input.bytes ||
      createHash('sha256').update(source).digest('hex') !== input.sha256
    )
      throw new BadRequestException('Private video checksum does not match');
    return source;
  }

  /** Caller owns scratch reservation and cleanup after this verified handoff. */
  async readToFile(
    scope: ShortsScope,
    job: PrivateSourceIdentity,
    path: string,
    signal?: AbortSignal,
  ): Promise<ShortsMediaFile> {
    const parts = await this.manifestParts(scope, job, signal);
    signal?.throwIfAborted();
    // Never overwrite a prior job's file or remove it if exclusive open fails.
    const file = await open(path, 'wx', 0o600);
    try {
      const hash = createHash('sha256');
      let bytes = 0;
      for (const ref of parts) {
        signal?.throwIfAborted();
        // Each object is authenticated before its bytes enter the scratch file.
        const part = await this.objects.get(scope, ref, signal);
        if (
          part.length !== ref.bytes ||
          createHash('sha256').update(part).digest('hex') !== ref.sha256
        )
          throw new BadRequestException('Private video part does not match');
        bytes += part.length;
        if (bytes > job.input.bytes)
          throw new BadRequestException('Private video length does not match');
        hash.update(part);
        await file.writeFile(part, { signal });
      }
      signal?.throwIfAborted();
      const sha256 = hash.digest('hex');
      if (bytes !== job.input.bytes || sha256 !== job.input.sha256)
        throw new BadRequestException('Private video checksum does not match');
      await file.close();
      return { path, bytes, sha256 };
    } catch (error) {
      await file.close();
      await rm(path, { force: true });
      throw error;
    }
  }
}
