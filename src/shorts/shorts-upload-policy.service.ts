import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { ShortsContractPolicy } from './shorts-contract-policy';
import { SHORTS_ORIGINAL_HARD_LIMIT } from './shorts-media-file';
import { SHORTS_ORIGINAL_PROFILE } from './shorts-rendition-policy';
import {
  SHORTS_LEGACY_UPLOAD_BYTES,
  SHORTS_UPLOAD_PART_BYTES,
} from './shorts-upload-policy';
import type { UploadInput } from './shorts-uploads.service';

export const SHORTS_UPLOAD_POLICY = Symbol('SHORTS_UPLOAD_POLICY');
export interface ShortsUploadPolicyConfig {
  originals: boolean;
  maxOriginalBytes: number;
  /** Advertise only after every replica accepts request keys. */
  creationKeys?: boolean;
}

export function shortsUploadPolicyConfig(
  env: NodeJS.ProcessEnv = process.env,
): ShortsUploadPolicyConfig {
  const enabled = env.SHORTS_ORIGINAL_UPLOADS_ENABLED ?? 'false';
  const creationKeys = env.SHORTS_UPLOAD_REQUEST_KEYS_ADVERTISED ?? 'false';
  if (!['true', 'false'].includes(creationKeys))
    throw new Error(
      'SHORTS_UPLOAD_REQUEST_KEYS_ADVERTISED must be true or false',
    );
  const bytes =
    env.SHORTS_ORIGINAL_UPLOAD_MAX_BYTES ?? String(SHORTS_ORIGINAL_HARD_LIMIT);
  if (!['true', 'false'].includes(enabled))
    throw new Error('SHORTS_ORIGINAL_UPLOADS_ENABLED must be true or false');
  if (
    !/^[1-9]\d{0,8}$/.test(bytes) ||
    Number(bytes) > SHORTS_ORIGINAL_HARD_LIMIT
  )
    throw new Error(
      'SHORTS_ORIGINAL_UPLOAD_MAX_BYTES must be between 1 and 100000000',
    );
  return {
    originals: enabled === 'true',
    maxOriginalBytes: Number(bytes),
    creationKeys: creationKeys === 'true',
  };
}

/** Admission policy for new sessions only. Reads/retries use the saved policy. */
@Injectable()
export class ShortsUploadPolicyService {
  constructor(
    @Inject(SHORTS_UPLOAD_POLICY)
    private readonly config: ShortsUploadPolicyConfig,
  ) {}

  describe(policy: ShortsContractPolicy, shared: boolean) {
    if (this.config.originals && !shared)
      throw new Error('Original uploads require shared hosted storage');
    if (
      !Number.isSafeInteger(policy.maxVideoBytes) ||
      policy.maxVideoBytes < 1 ||
      policy.maxVideoBytes > SHORTS_ORIGINAL_HARD_LIMIT
    )
      throw new Error('Invalid active upload limit');
    const originals = shared && this.config.originals;
    return {
      version: 1 as const,
      transport: shared ? ('direct-s3-v1' as const) : ('api-parts-v1' as const),
      format: originals
        ? ('original-file-v1' as const)
        : ('legacy-directory-v1' as const),
      maxBytes: Math.min(
        policy.maxVideoBytes,
        originals ? this.config.maxOriginalBytes : SHORTS_LEGACY_UPLOAD_BYTES,
      ),
      partSize: SHORTS_UPLOAD_PART_BYTES,
      minDuration: 2,
      maxDuration: 60,
      ...(shared && this.config.creationKeys
        ? { creation: 'request-key-v1' as const }
        : {}),
    };
  }

  accept(
    input: UploadInput,
    policy: ShortsContractPolicy,
    shared = true,
  ): UploadInput {
    const capability = this.describe(policy, shared);
    if (
      !input ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > capability.maxBytes
    )
      throw new BadRequestException('Video exceeds the current upload limit');
    if (
      input.expectedFormat !== undefined &&
      input.expectedFormat !== capability.format
    )
      throw new ConflictException(
        'Upload format changed. Reload upload settings before starting.',
      );
    // Only public creation fields cross this boundary. In particular, caller JSON
    // cannot select a profile, expand its frozen limit or provide private references.
    return {
      title: input.title,
      topic: input.topic,
      rights: input.rights,
      bytes: input.bytes,
      sha256: input.sha256,
      details: input.details,
      acceptedMaxBytes: capability.maxBytes,
      ...(capability.format === 'original-file-v1'
        ? { processingProfile: SHORTS_ORIGINAL_PROFILE }
        : {}),
    };
  }
}
