import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { ShortRecord } from './shorts.types';
import { shortsDeliverySource } from './shorts-delivery-source';
import { SHORTS_RENDITION_MAX_BYTES } from './shorts-rendition-policy';
import { derivativeLimit } from './hls-protocol/playback-descriptor';
import { DeliveryExpectation } from './shorts-delivery-selection.service';

export interface BackfillBudget {
  replicas: number;
  maxAdditionalLogicalBytes: number;
  maxEncodingSeconds: number;
}
export interface BackfillItemPlan {
  id: string;
  fingerprint: string;
  expected: DeliveryExpectation;
  sourceBytes: number;
}
export interface BackfillPlan {
  version: 1;
  items: BackfillItemPlan[];
  skipped: { id: string; reason: string }[];
  cost: {
    retainedSourceBytes: number;
    privateLogicalBytes: number;
    publicLogicalBytes: number;
    additionalLogicalBytes: number;
    encodingSeconds: number;
  };
  hash: string;
}
export const backfillHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function backfillRequest(ids: string[], budget: BackfillBudget) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 10 ||
    ids.some(
      (id) => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id),
    ) ||
    new Set(ids).size !== ids.length ||
    !Number.isSafeInteger(budget?.replicas) ||
    budget.replicas < 1 ||
    budget.replicas > 8 ||
    !Number.isSafeInteger(budget.maxAdditionalLogicalBytes) ||
    budget.maxAdditionalLogicalBytes < 1 ||
    !Number.isSafeInteger(budget.maxEncodingSeconds) ||
    budget.maxEncodingSeconds < 1
  )
    throw new BadRequestException('Invalid backfill cohort or budget');
  return {
    ids: [...ids].sort(),
    budget: {
      replicas: budget.replicas,
      maxAdditionalLogicalBytes: budget.maxAdditionalLogicalBytes,
      maxEncodingSeconds: budget.maxEncodingSeconds,
    },
  };
}

/** Excludes changing engagement counters, includes every preparation input. */
export function backfillFingerprint(short: ShortRecord) {
  return backfillHash([
    short.id,
    short.creator,
    short.cid,
    short.bytes,
    shortsDeliverySource(short),
    short.title,
    short.topic,
    short.duration,
    short.description || '',
    short.language || 'und',
    short.synthetic === true,
    short.sponsored === true,
    short.captions === true,
    short.files.find((file) => file.name === 'captions.vtt') || null,
  ]);
}

/** Conservative logical payload allocation, not predicted billing or disk usage. */
export function backfillCost(items: BackfillItemPlan[], replicas: number) {
  const retainedSourceBytes = items.reduce(
    (sum, item) => sum + item.sourceBytes,
    0,
  );
  // One restaged source and up to three fenced encoding attempts. Include
  // originals/outputs and a bounded allowance for manifests and encryption tags.
  const privateLogicalBytes =
    retainedSourceBytes * 4 +
    items.length * (3 * SHORTS_RENDITION_MAX_BYTES + 1048576);
  const publicLogicalBytes =
    retainedSourceBytes +
    items.length * (SHORTS_RENDITION_MAX_BYTES + derivativeLimit);
  return {
    retainedSourceBytes,
    privateLogicalBytes,
    publicLogicalBytes,
    additionalLogicalBytes:
      (privateLogicalBytes + publicLogicalBytes) * replicas,
    encodingSeconds: items.length * 3 * 600,
  };
}
