import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { ShortsContractPolicy } from './shorts-contract-policy';
import { SHORTS_ORIGINAL_HARD_LIMIT } from './shorts-media-file';
import { SHORTS_ORIGINAL_PROFILE } from './shorts-rendition-policy';
import { SHORTS_UPLOAD_PART_BYTES } from './shorts-upload-policy';
import type { UploadInput } from './shorts-upload-input';

export const SHORTS_UPLOAD_POLICY = Symbol('SHORTS_UPLOAD_POLICY');
export interface ShortsUploadPolicyConfig {
  maxOriginalBytes: number;
  /** Advertise only after every replica accepts request keys. */
  creationKeys?: boolean;
}

export function shortsUploadPolicyConfig(
  env: NodeJS.ProcessEnv = process.env,
): ShortsUploadPolicyConfig {
  const creationKeys = env.SHORTS_UPLOAD_REQUEST_KEYS_ADVERTISED ?? 'false';
  if (!['true', 'false'].includes(creationKeys))
    throw new Error(
      'SHORTS_UPLOAD_REQUEST_KEYS_ADVERTISED must be true or false',
    );
  const bytes =
    env.SHORTS_ORIGINAL_UPLOAD_MAX_BYTES ?? String(SHORTS_ORIGINAL_HARD_LIMIT);
  if (
    !/^[1-9]\d{0,8}$/.test(bytes) ||
    Number(bytes) > SHORTS_ORIGINAL_HARD_LIMIT
  )
    throw new Error(
      'SHORTS_ORIGINAL_UPLOAD_MAX_BYTES must be between 1 and 100000000',
    );
  return {
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

  describe(policy: ShortsContractPolicy) {
    if (
      !Number.isSafeInteger(policy.maxVideoBytes) ||
      policy.maxVideoBytes < 1 ||
      policy.maxVideoBytes > SHORTS_ORIGINAL_HARD_LIMIT
    )
      throw new Error('Invalid active upload limit');
    return {
      version: 1 as const,
      transport: 'direct-s3-v1' as const,
      format: 'original-file-v1' as const,
      maxBytes: Math.min(policy.maxVideoBytes, this.config.maxOriginalBytes),
      partSize: SHORTS_UPLOAD_PART_BYTES,
      minDuration: 2,
      maxDuration: 60,
      ...(this.config.creationKeys
        ? { creation: 'request-key-v1' as const }
        : {}),
    };
  }

  accept(input: UploadInput, policy: ShortsContractPolicy): UploadInput {
    const capability = this.describe(policy);
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
      processingProfile: SHORTS_ORIGINAL_PROFILE,
    };
  }
}
