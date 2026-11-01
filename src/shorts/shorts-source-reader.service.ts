import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
  input: Pick<IngestionInput, 'objectKey' | 'manifest' | 'sha256' | 'bytes'>;
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
    signal?.throwIfAborted();
    const input = job.input;
    if (
      !input ||
      !input.manifest ||
      input.manifest.key !== input.objectKey ||
      input.manifest.bytes > 32768
    )
      throw new BadRequestException('Invalid private source manifest');
    const manifestBytes = await this.objects.get(scope, input.manifest, signal);
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
      input.bytes > 40 * SHORTS_PART_BYTES ||
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
    return parts;
  }
  async read(
    scope: ShortsScope,
    job: Pick<IngestionJob, 'id' | 'creator' | 'input'>,
    signal?: AbortSignal,
  ): Promise<Buffer> {
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
}
