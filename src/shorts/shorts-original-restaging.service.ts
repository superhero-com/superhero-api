import { SHORTS_SOURCE_MANIFEST_BYTES } from './shorts-upload-policy';
import { ConflictException, Injectable } from '@nestjs/common';
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
import type { ShortRecord } from './shorts.types';
import { readOriginalPart } from './shorts-restaging-parts';
import {
  DeliveryStagingClaim,
  ShortsDeliveryStagingService,
} from './shorts-delivery-staging.service';
import { SHORTS_PART_BYTES } from './shorts-upload-records.service';
import { shortsDeliverySource } from './shorts-delivery-source';
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
    shortsDeliverySource(short);
    const previous = await this.staging.get(scope, jobId);
    if (previous && previous.shortId !== shortId)
      throw new ConflictException('Staging job belongs to another Short');
    if (previous?.state === 'ready') return { jobId, shortId, ready: true };
    if (this.media.remoteRestagingEnabled) {
      return this.media.withRestagingTransfer(
        scope,
        short,
        signal,
        async (client, sourceHash, active) => {
          let plan: Pick<DeliveryStagingClaim, 'input' | 'manifest'> = previous;
          if (!plan) {
            const source = await client.planRestaging(
              scope,
              sourceHash,
              short,
              jobId,
              active,
            );
            if (!(await this.media.pinned(short.cid, active)))
              throw new Error(
                'Canonical original pin changed during restaging',
              );
            plan = this.plan(
              scope,
              short,
              jobId,
              source.hashes,
              source.captions,
            );
          }
          return this.restore(
            scope,
            short,
            jobId,
            plan,
            active,
            async (claim, parts) => {
              await client.writeRestaging(
                scope,
                sourceHash,
                short,
                claim,
                parts.map((p) => p.object),
                active,
              );
              if (!(await this.media.pinned(short.cid, active)))
                throw new Error(
                  'Canonical original pin changed during restaging',
                );
            },
          );
        },
      );
    }
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
    return this.media.withPinnedOriginal(
      short,
      async (file, active) => {
        const handle = await open(file.path, 'r');
        try {
          let plan: Pick<DeliveryStagingClaim, 'input' | 'manifest'> = previous;
          if (!plan) {
            const hashes: string[] = [];
            for (let i = 0; i < Math.ceil(file.bytes / SHORTS_PART_BYTES); i++)
              hashes.push(
                digest(await readOriginalPart(handle, file.bytes, i, active)),
              );
            plan = this.plan(scope, short, jobId, hashes, captions);
          }
          return await this.restore(
            scope,
            short,
            jobId,
            plan,
            active,
            async (_claim, parts) => {
              for (const part of parts) {
                const bytes = await readOriginalPart(
                  handle,
                  file.bytes,
                  part.index,
                  active,
                );
                await this.objects.putPlanned(
                  scope,
                  part.object,
                  bytes,
                  active,
                );
                const stored = await this.objects.get(
                  scope,
                  part.object,
                  active,
                );
                if (
                  stored.length !== bytes.length ||
                  digest(stored) !== part.object.sha256
                )
                  throw new Error('Restaged source verification failed');
              }
            },
          );
        } finally {
          await handle.close();
        }
      },
      signal,
    );
  }
  private plan(
    scope: ShortsScope,
    short: ShortRecord,
    jobId: string,
    hashes: string[],
    captions?: string,
  ) {
    const parts = hashes.map((sha256, index) => ({
      index,
      object: this.objects.plannedReference(
        scope,
        jobId,
        'restage-part/' + index,
        {
          bytes: Math.min(
            SHORTS_PART_BYTES,
            short.bytes - index * SHORTS_PART_BYTES,
          ),
          sha256,
        },
      ),
    }));
    const manifest = JSON.stringify({
      version: 1,
      id: jobId,
      creator: short.creator,
      bytes: short.bytes,
      sha256: short.original.sha256,
      parts,
    });
    if (Buffer.byteLength(manifest) > SHORTS_SOURCE_MANIFEST_BYTES)
      throw new Error('Original manifest exceeds the staging budget');
    const ref = this.objects.plannedReference(scope, jobId, 'source-manifest', {
      bytes: Buffer.byteLength(manifest),
      sha256: digest(Buffer.from(manifest)),
    });
    const input: IngestionInput = {
      objectKey: ref.key,
      manifest: ref,
      processingProfile: 'original-h264-v1',
      bytes: short.bytes,
      sha256: short.original.sha256,
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
    return { input, manifest };
  }
  private async restore(
    scope: ShortsScope,
    short: ShortRecord,
    jobId: string,
    plan: Pick<DeliveryStagingClaim, 'input' | 'manifest'>,
    signal: AbortSignal,
    write: (
      claim: DeliveryStagingClaim,
      parts: { index: number; object: PrivateObjectRef }[],
    ) => Promise<void>,
  ) {
    signal.throwIfAborted();
    const claim = await this.staging.reserve(
      scope,
      jobId,
      short.id,
      plan.input,
      plan.manifest,
    );
    const ready = { jobId, shortId: short.id, ready: true };
    if (claim.state === 'ready') return ready;
    try {
      await write(claim, JSON.parse(claim.manifest).parts);
      signal.throwIfAborted();
      const manifest = Buffer.from(claim.manifest);
      await this.objects.putPlanned(
        scope,
        claim.input.manifest!,
        manifest,
        signal,
      );
      const saved = await this.objects.get(
        scope,
        claim.input.manifest!,
        signal,
      );
      if (!saved.equals(manifest))
        throw new Error('Restaged manifest verification failed');
      signal.throwIfAborted();
      await this.staging.finish(scope, claim);
      return ready;
    } catch (error) {
      await this.staging.fail(scope, claim).catch(() => undefined);
      throw error;
    }
  }
}
