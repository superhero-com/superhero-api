import { SHORTS_SOURCE_MANIFEST_BYTES } from './shorts-upload-policy';
import { ConflictException, Injectable, Optional } from '@nestjs/common';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ShortsMediaService } from './shorts-media.service';
import {
  ShortsMetadataService,
  ShortsScope,
  IngestionInput,
} from './shorts-metadata.service';
import {
  ShortsPrivateObjectsService,
  PrivateObjectRef,
} from './shorts-private-objects.service';
import { ShortsDeliveryStagingService } from './shorts-delivery-staging.service';
import { SHORTS_PART_BYTES } from './shorts-upload-records.service';
import {
  shortsDeliverySource,
  assertDeliverySourcePreparation,
} from './shorts-delivery-source';
import { ShortsPrivateMediaService } from './shorts-private-media.service';
import { officialContentPolicy } from './shorts-eligibility';

const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

/** Explicit internal operation. Does not approve, publish or select a generation. */
@Injectable()
export class ShortsOriginalRestagingService {
  constructor(
    private readonly metadata: ShortsMetadataService,
    private readonly media: ShortsMediaService,
    private readonly objects: ShortsPrivateObjectsService,
    private readonly staging: ShortsDeliveryStagingService,
    @Optional() private readonly privateMedia?: ShortsPrivateMediaService,
  ) {}
  async restage(
    scope: ShortsScope,
    shortId: string,
    jobId: string,
    parent?: AbortSignal,
  ) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(180000),
      ...(parent ? [parent] : []),
    ]);
    signal.throwIfAborted();
    const { record: short } = await this.metadata.get(scope, shortId);
    if (
      short.publication !== 'published' ||
      !officialContentPolicy(short).serve
    )
      throw new ConflictException(
        'Original Short is not eligible for restaging',
      );
    const source = shortsDeliverySource(short);
    assertDeliverySourcePreparation(source);
    if (source.kind === 'retained-upload' && !this.privateMedia)
      throw new Error('Retained source reader unavailable');
    const previous = await this.staging.get(scope, jobId);
    if (previous && previous.shortId !== shortId)
      throw new ConflictException('Staging job belongs to another Short');
    if (previous?.state === 'ready') return { jobId, shortId, ready: true };
    let captions: string | undefined;
    if (!previous && short.captions) {
      const declared = short.files.find(
        (entry) => entry.name === 'captions.vtt',
      );
      if (!declared || declared.bytes > 8192)
        throw new Error('Canonical captions exceed the staging budget');
      captions = new TextDecoder('utf-8', { fatal: true }).decode(
        await this.media.retrieve(short, 'captions.vtt', signal),
      );
    }
    const prepare = async (
      file: import('./shorts-media-file').ShortsMediaFile,
      active: AbortSignal,
    ) => {
      const handle = await open(file.path, 'r');
      try {
        const readPart = async (index: number) => {
          active.throwIfAborted();
          const bytes = Buffer.alloc(
            Math.min(SHORTS_PART_BYTES, file.bytes - index * SHORTS_PART_BYTES),
          );
          let offset = 0;
          while (offset < bytes.length) {
            active.throwIfAborted();
            const read = await handle.read(
              bytes,
              offset,
              bytes.length - offset,
              index * SHORTS_PART_BYTES + offset,
            );
            if (!read.bytesRead)
              throw new Error('Verified original changed during staging');
            offset += read.bytesRead;
          }
          return bytes;
        };
        let input: IngestionInput, manifest: string;
        if (previous) {
          input = previous.input;
          manifest = previous.manifest;
        } else {
          const parts: { index: number; object: PrivateObjectRef }[] = [];
          for (
            let index = 0;
            index < Math.ceil(file.bytes / SHORTS_PART_BYTES);
            index++
          ) {
            const bytes = await readPart(index);
            parts.push({
              index,
              object: this.objects.plannedReference(
                scope,
                jobId,
                `restage-part/${index}`,
                { bytes: bytes.length, sha256: digest(bytes) },
              ),
            });
          }
          manifest = JSON.stringify({
            version: 1,
            id: jobId,
            creator: short.creator,
            bytes: file.bytes,
            sha256: file.sha256,
            parts,
          });
          if (Buffer.byteLength(manifest) > SHORTS_SOURCE_MANIFEST_BYTES)
            throw new Error('Original manifest exceeds the staging budget');
          const ref = this.objects.plannedReference(
            scope,
            jobId,
            'source-manifest',
            {
              bytes: Buffer.byteLength(manifest),
              sha256: digest(Buffer.from(manifest)),
            },
          );
          input = {
            objectKey: ref.key,
            manifest: ref,
            processingProfile: 'original-h264-v1',
            bytes: file.bytes,
            sha256: file.sha256,
            title: short.title,
            topic: short.topic,
            details: {
              description: short.description || '',
              language: short.language || 'und',
              synthetic: short.synthetic === true,
              sponsored: short.sponsored === true,
              ...(captions ? { captions } : {}),
            },
          };
        }
        active.throwIfAborted();
        const claim = await this.staging.reserve(
          scope,
          jobId,
          shortId,
          input,
          manifest,
        );
        if (claim.state === 'ready') return { jobId, shortId, ready: true };
        try {
          const parts: { index: number; object: PrivateObjectRef }[] =
            JSON.parse(claim.manifest).parts;
          // The durable reservation is visible before any private bytes are written.
          for (const part of parts) {
            const bytes = await readPart(part.index);
            await this.objects.putPlanned(scope, part.object, bytes, active);
            // Authenticate the stored bytes, including uncertain earlier writes.
            const stored = await this.objects.get(scope, part.object, active);
            if (
              stored.length !== bytes.length ||
              digest(stored) !== part.object.sha256
            )
              throw new Error('Restaged source verification failed');
          }
          await this.objects.putPlanned(
            scope,
            claim.input.manifest!,
            Buffer.from(claim.manifest),
            active,
          );
          const saved = await this.objects.get(
            scope,
            claim.input.manifest!,
            active,
          );
          if (saved.toString('utf8') !== claim.manifest)
            throw new Error('Restaged manifest verification failed');
          active.throwIfAborted();
          await this.staging.finish(scope, claim);
          return { jobId, shortId, ready: true };
        } catch (error) {
          // A failed acknowledgement may have committed. Fenced failure cannot undo ready.
          await this.staging.fail(scope, claim).catch(() => undefined);
          throw error;
        }
      } finally {
        await handle.close();
      }
    };
    return source.kind === 'published-file'
      ? this.media.withPinnedOriginal(short, prepare, signal)
      : this.privateMedia.withRetainedOriginal(scope, short, prepare, signal);
  }
}
