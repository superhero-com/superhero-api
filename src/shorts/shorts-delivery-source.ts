import { validateOriginalContent } from './shorts-original-content';
import {
  shortsSourceLimit,
  SHORTS_SOURCE_MANIFEST_BYTES,
} from './shorts-upload-policy';
import type { ShortRecord } from './shorts.types';
import { ServiceUnavailableException } from '@nestjs/common';

export function assertDeliverySourcePreparation(
  source: ReturnType<typeof shortsDeliverySource>,
) {
  if (
    source.kind === 'retained-upload' &&
    process.env.SHORTS_LEGACY_BACKFILL_ENABLED !== 'true'
  )
    throw new ServiceUnavailableException(
      'Legacy delivery preparation is disabled',
    );
}

/** The preparation source is distinct from a legacy post's immutable package CID. */
export function shortsDeliverySource(short: ShortRecord) {
  if (validateOriginalContent(short))
    return {
      kind: 'published-file' as const,
      bytes: short.bytes,
      sha256: short.original.sha256,
    };
  const privateMedia = short.privateMedia,
    input = privateMedia?.source,
    manifest = input?.manifest;
  if (
    privateMedia?.version !== 1 ||
    typeof privateMedia.fence !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(privateMedia.fence) ||
    BigInt(privateMedia.fence) > 9223372036854775807n ||
    input?.processingProfile !== undefined ||
    !Number.isSafeInteger(input?.bytes) ||
    input.bytes < 1 ||
    input.bytes > shortsSourceLimit(input) ||
    !/^[a-f0-9]{64}$/.test(input.sha256 || '') ||
    short.safety?.sourceSha256 !== input.sha256 ||
    !manifest ||
    manifest.key !== input.objectKey ||
    typeof manifest.key !== 'string' ||
    manifest.key.length > 512 ||
    !/^[a-zA-Z0-9_/-]+$/.test(manifest.key) ||
    manifest.key.includes('//') ||
    !/^[a-zA-Z0-9_-]{1,32}$/.test(manifest.keyId || '') ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') ||
    !manifest.key.endsWith(`/${manifest.keyId}/${manifest.sha256}`) ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 1 ||
    manifest.bytes > SHORTS_SOURCE_MANIFEST_BYTES
  )
    throw new Error('Verified retained original source is unavailable');
  return {
    kind: 'retained-upload' as const,
    bytes: input.bytes,
    sha256: input.sha256,
  };
}
