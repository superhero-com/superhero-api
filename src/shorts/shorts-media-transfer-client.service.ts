import type { PrivateObjectRef } from './shorts-private-objects.service';
import { validateVisualEvidence, VisualSafety } from './shorts-safety.service';
import { SHORTS_UPLOAD_PART_BYTES } from './shorts-upload-policy';
import type { DeliveryStagingClaim } from './shorts-delivery-staging.service';
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ShortRecord } from './shorts.types';
import { ShortsScope } from './shorts-metadata.service';
import { derivedFiles } from './shorts-original-content';
import { shortsPlaybackDescriptor } from './shorts-playback-descriptor';
import {
  TransferPurpose,
  TransferGrant,
  StoragePinReceipt,
  inspectionProof,
  pinTransferProof,
  pinPackageCid,
  restagingTargetHash,
  restagingProof,
  previewProof,
  PreviewReceipt,
  RestagingGrant,
  RestagingPlan,
} from './shorts-transfer-protocol';
import { discardShortsResponse, readShortsJson } from './shorts-upstream';
import { ShortsMediaUnavailableError } from './shorts-media-admission.service';

function pinReference(ref: PrivateObjectRef | undefined) {
  if (!ref) throw new Error('Missing private media reference');
  const { key, keyId, bytes, sha256 } = ref;
  return { key, keyId, bytes, sha256 };
}

@Injectable()
export class ShortsMediaTransferClientService {
  private readonly origin?: string;
  private readonly keyFile?: string;
  readonly previewEnabled: boolean;
  readonly rescanEnabled: boolean;
  readonly restagingEnabled: boolean;
  constructor() {
    const endpoint = process.env.SHORTS_MEDIA_TRANSFER_URL;
    const enabled = (name: string) => {
      const flag = process.env[name] ?? 'false';
      if (!['true', 'false'].includes(flag) || (flag === 'true' && !endpoint))
        throw new Error(
          name +
            ' requires a boolean and a configured transfer origin when enabled',
        );
      return flag === 'true';
    };
    this.previewEnabled = enabled('SHORTS_MEDIA_TRANSFER_PREVIEW');
    this.rescanEnabled = enabled('SHORTS_MEDIA_TRANSFER_RESCAN');
    this.restagingEnabled = enabled('SHORTS_MEDIA_TRANSFER_RESTAGING');
    if (!endpoint) return;
    const url = new URL(endpoint),
      local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          local &&
          process.env.NODE_ENV !== 'production'
        ))
    )
      throw new Error(
        'SHORTS_MEDIA_TRANSFER_URL requires a private HTTPS origin',
      );
    this.origin = url.origin;
    this.keyFile = process.env.SHORTS_MEDIA_TRANSFER_KEY_FILE;
    if (!this.keyFile || !isAbsolute(this.keyFile))
      throw new Error('Media transfer requires an absolute credential path');
  }
  get enabled() {
    return this.origin !== undefined;
  }
  private originalStaging(short: ShortRecord) {
    const { manifest, objectKey, acceptedMaxBytes } =
      short.privateMedia?.source || {};
    if (!manifest || manifest.key !== objectKey)
      throw new Error('Invalid private source manifest');
    return {
      manifest: pinReference(manifest),
      creator: short.creator,
      acceptedMaxBytes,
    };
  }
  async transfer(
    scope: ShortsScope,
    sourceHash: string,
    short: ShortRecord,
    purpose: TransferPurpose,
    grant: TransferGrant | null,
    signal: AbortSignal,
    reject?: () => void,
  ): Promise<StoragePinReceipt | null> {
    const descriptor = shortsPlaybackDescriptor(short, scope);
    let staging;
    if (grant) {
      const privateMedia = short.privateMedia;
      if (!privateMedia) throw new Error('Missing private pin source');
      if (purpose === 'original') {
        staging = this.originalStaging(short);
      } else {
        staging = {
          files: Object.fromEntries(
            derivedFiles(short.files, purpose).map((f) => [
              f.name,
              pinReference(privateMedia.files[f.name]),
            ]),
          ),
        };
      }
    }
    const cid = pinPackageCid(short, purpose);
    const expires = Math.min(
      Date.now() + 180000,
      grant?.mode === 'expiring' ? grant.expires : Infinity,
    );
    const { result, status, request, key } = await this.post(
      'pin',
      sourceHash,
      { descriptor, purpose, grant, staging },
      expires,
      signal,
    );
    if (
      result?.version !== 1 ||
      result.cid !== cid ||
      typeof result.proof !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.proof) ||
      !timingSafeEqual(
        Buffer.from(result.proof, 'hex'),
        Buffer.from(pinTransferProof(key, request, cid, result.receipt), 'hex'),
      )
    )
      throw new Error('Media pin transfer acknowledgement mismatch');
    if (status === 409) {
      if (grant?.mode === 'expiring' && result.receipt === 'rejected')
        reject?.();
      throw new ShortsMediaUnavailableError();
    }
    if (
      grant?.mode === 'expiring'
        ? !result.receipt ||
          result.receipt.operation !== grant.operation ||
          result.receipt.epoch !== grant.epoch ||
          result.receipt.expires !== grant.expires ||
          result.receipt.version !== 1 ||
          result.receipt.status !== 'pinned' ||
          result.receipt.cid !== cid
        : result.receipt !== null
    )
      throw new Error('Media pin transfer acknowledgement mismatch');
    return result.receipt;
  }
  private async restageRequest(
    phase: 'plan' | 'write',
    scope: ShortsScope,
    sourceHash: string,
    short: ShortRecord,
    jobId: string,
    expires: number,
    signal: AbortSignal,
    grant?: RestagingGrant,
  ) {
    const descriptor = shortsPlaybackDescriptor(short, scope);
    const {
      result: reply,
      request,
      key,
    } = await this.post(
      phase === 'plan' ? 'restage-plan' : 'restage-write',
      sourceHash,
      { descriptor, jobId, grant },
      expires,
      signal,
    );
    if (
      reply?.version !== 1 ||
      !reply.result ||
      typeof reply.proof !== 'string' ||
      !/^[a-f0-9]{64}$/.test(reply.proof) ||
      !timingSafeEqual(
        Buffer.from(reply.proof, 'hex'),
        Buffer.from(restagingProof(key, request, phase, reply.result), 'hex'),
      )
    )
      throw new Error('Original restaging acknowledgement mismatch');
    return reply.result;
  }
  async planRestaging(
    scope: ShortsScope,
    sourceHash: string,
    short: ShortRecord,
    jobId: string,
    signal: AbortSignal,
  ) {
    const plan: RestagingPlan = await this.restageRequest(
      'plan',
      scope,
      sourceHash,
      short,
      jobId,
      Date.now() + 180000,
      signal,
    );
    if (
      !Array.isArray(plan.hashes) ||
      plan.hashes.length !==
        Math.ceil(short.bytes / SHORTS_UPLOAD_PART_BYTES) ||
      !plan.hashes.every(
        (h) => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h),
      )
    )
      throw new Error('Invalid original restaging plan');
    const entry = short.files.find((f) => f.name === 'captions.vtt');
    let captions: string | undefined;
    if (entry) {
      if (
        entry.bytes > 8192 ||
        typeof plan.captions !== 'string' ||
        plan.captions.length !== Math.ceil(entry.bytes / 3) * 4
      )
        throw new Error('Invalid restaged captions');
      const data = Buffer.from(plan.captions, 'base64');
      if (
        data.length !== entry.bytes ||
        createHash('sha256').update(data).digest('hex') !== entry.sha256
      )
        throw new Error('Restaged captions differ from original');
      captions = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } else if (plan.captions !== undefined)
      throw new Error('Unexpected restaged captions');
    return { hashes: plan.hashes, captions };
  }
  async writeRestaging(
    scope: ShortsScope,
    sourceHash: string,
    short: ShortRecord,
    claim: DeliveryStagingClaim,
    refs: PrivateObjectRef[],
    signal: AbortSignal,
  ) {
    if (
      !claim.token ||
      claim.state !== 'staging' ||
      !Number.isSafeInteger(claim.expiresAt) ||
      claim.shortId !== short.id
    )
      throw new Error('Original staging lease unavailable');
    const manifestSha256 = createHash('sha256')
      .update(claim.manifest)
      .digest('hex');
    if (claim.input.manifest?.sha256 !== manifestSha256)
      throw new Error('Invalid reserved staging manifest');
    const grant: RestagingGrant = {
      leaseHash: createHash('sha256').update(claim.token).digest('hex'),
      fence: claim.fence,
      manifestSha256,
      targetHash: restagingTargetHash(refs),
      targets: refs.map(({ keyId, sha256 }) => ({ keyId, sha256 })),
    };
    const ack = await this.restageRequest(
      'write',
      scope,
      sourceHash,
      short,
      claim.jobId,
      Math.min(claim.expiresAt, Date.now() + 180000),
      signal,
      grant,
    );
    if (ack.targetHash !== grant.targetHash || ack.parts !== refs.length)
      throw new Error('Restaged objects differ from reservation');
  }
  async preparePreview(
    scope: ShortsScope,
    sourceHash: string,
    short: ShortRecord,
    signal: AbortSignal,
  ) {
    const descriptor = shortsPlaybackDescriptor(short, scope);
    const file = descriptor.files.find((f) => f.name === 'video.mp4');
    if (!file || file.bytes > 64 * 1024 * 1024)
      throw new Error('Invalid review preview');
    const pinned =
      short.publication === 'published' || short.publication === 'withdrawn';
    const staging = pinned
      ? undefined
      : {
          files: {
            'video.mp4': pinReference(short.privateMedia?.files?.['video.mp4']),
          },
        };
    const { result, request, key } = await this.post(
      'review-preview',
      sourceHash,
      { descriptor, source: pinned ? 'pinned' : 'private', staging },
      Date.now() + 180000,
      signal,
    );
    const receipt: PreviewReceipt = result?.receipt;
    if (
      result?.version !== 1 ||
      !receipt ||
      typeof receipt.node !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,31}$/.test(receipt.node) ||
      typeof receipt.ticket !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.ticket) ||
      receipt.bytes !== file.bytes ||
      receipt.sha256 !== file.sha256 ||
      !Number.isSafeInteger(receipt.expires) ||
      Date.now() >= receipt.expires ||
      receipt.expires > Date.now() + 15000 ||
      typeof result.proof !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.proof) ||
      !timingSafeEqual(
        Buffer.from(result.proof, 'hex'),
        Buffer.from(previewProof(key, request, receipt), 'hex'),
      )
    )
      throw new Error('Review preview acknowledgement mismatch');
    return '/_shorts_review_preview/' + receipt.node + '/' + receipt.ticket;
  }
  async inspectionHealth(
    scope: ShortsScope,
    sourceHash: string,
    signal: AbortSignal,
  ) {
    const { result } = await this.post(
      'inspection-health',
      sourceHash,
      { scope },
      Date.now() + 4000,
      signal,
    );
    return result?.version === 1 && result.ready === true;
  }
  async inspect(
    scope: ShortsScope,
    sourceHash: string,
    short: ShortRecord,
    source: 'pinned' | 'private',
    signal: AbortSignal,
  ): Promise<VisualSafety> {
    const checkedAt = Date.now();
    const descriptor = shortsPlaybackDescriptor(short, scope);
    const staging =
      source === 'private' ? this.originalStaging(short) : undefined;
    const { result, key, request } = await this.post(
      'inspect',
      sourceHash,
      { descriptor, source, staging, scanGeneration: short.scanGeneration },
      checkedAt + 180000,
      signal,
    );
    const evidence = result?.evidence;
    if (
      result?.version !== 1 ||
      !evidence ||
      typeof result.proof !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.proof) ||
      !timingSafeEqual(
        Buffer.from(result.proof, 'hex'),
        Buffer.from(inspectionProof(key, request, evidence), 'hex'),
      ) ||
      evidence.sourceSha256 !== short.original.sha256 ||
      evidence.humanReviewRequired !== true
    )
      throw new Error('Media inspection acknowledgement mismatch');
    if (evidence.status === 'error') {
      if (typeof evidence.reason !== 'string' || evidence.reason.length > 1000)
        throw new Error('Invalid inspection failure');
      return {
        sourceSha256: short.original.sha256,
        checkedAt,
        humanReviewRequired: true,
        status: 'error',
        reason: evidence.reason,
      };
    }
    validateVisualEvidence(evidence, short.original.sha256);
    return { ...evidence, checkedAt };
  }
  private async post(
    operation:
      | 'pin'
      | 'inspect'
      | 'inspection-health'
      | 'review-preview'
      | 'restage-plan'
      | 'restage-write',
    sourceHash: string,
    fields: Record<string, unknown>,
    expires: number,
    signal: AbortSignal,
  ) {
    if (!this.origin || !this.keyFile || !/^[a-f0-9]{64}$/.test(sourceHash))
      throw new Error('Media transfer deployment unavailable');
    const key = (
      await readFile(this.keyFile, { encoding: 'utf8', signal })
    ).trim();
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error('Invalid media transfer credential');
    if (expires <= Date.now())
      throw new Error('Media transfer authority expired');
    const request = JSON.stringify({
      version: 1,
      challenge: randomBytes(32).toString('hex'),
      expires,
      sourceHash,
      ...fields,
    });
    if (Buffer.byteLength(request) > 32768)
      throw new Error('Media transfer metadata too large');
    const active = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, expires - Date.now())),
    ]);
    const response = await fetch(this.origin + '/internal/media/' + operation, {
      method: 'POST',
      redirect: 'error',
      signal: active,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body: request,
    }).catch(() => {
      active.throwIfAborted();
      throw new ShortsMediaUnavailableError();
    });
    if (
      response.status !== 200 &&
      !(operation === 'pin' && response.status === 409)
    ) {
      discardShortsResponse(response);
      throw new ShortsMediaUnavailableError();
    }
    // Scanner evidence is independently limited to 256 KiB, plus the signed envelope.
    const result = await readShortsJson(
      response,
      operation === 'inspect'
        ? 262144 + 1024
        : operation === 'restage-plan'
          ? 32768
          : 2048,
      active,
    );
    active.throwIfAborted();
    if (Date.now() >= expires)
      throw new Error('Media transfer acknowledgement expired');
    return { request, result, status: response.status, key };
  }
}
