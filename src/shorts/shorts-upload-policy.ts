import { SHORTS_ORIGINAL_HARD_LIMIT } from './shorts-media-file';
import { SHORTS_ORIGINAL_PROFILE } from './shorts-rendition-policy';

export const SHORTS_UPLOAD_PART_BYTES = 1048576;
export const SHORTS_LEGACY_UPLOAD_BYTES = 40 * SHORTS_UPLOAD_PART_BYTES;
export const SHORTS_MAX_SOURCE_PARTS = Math.ceil(
  SHORTS_ORIGINAL_HARD_LIMIT / SHORTS_UPLOAD_PART_BYTES,
);
export const SHORTS_SOURCE_MANIFEST_BYTES = 98304;

export interface AcceptedSourcePolicy {
  processingProfile?: typeof SHORTS_ORIGINAL_PROFILE;
  /** Frozen by the server at admission; current flags never reinterpret a retry. */
  acceptedMaxBytes?: number;
}

/** Zero denotes an invalid persisted policy, including an unknown profile. */
export function shortsSourceLimit(input: AcceptedSourcePolicy): number {
  if (
    input.processingProfile !== undefined &&
    input.processingProfile !== SHORTS_ORIGINAL_PROFILE
  )
    return 0;
  const ceiling =
    input.processingProfile === SHORTS_ORIGINAL_PROFILE
      ? SHORTS_ORIGINAL_HARD_LIMIT
      : SHORTS_LEGACY_UPLOAD_BYTES;
  const limit =
    input.acceptedMaxBytes === undefined ? ceiling : input.acceptedMaxBytes;
  return Number.isSafeInteger(limit) && limit > 0 && limit <= ceiling
    ? limit
    : 0;
}

export function shortsAcceptedSource(
  input: AcceptedSourcePolicy & { bytes: number; sha256: string },
) {
  return {
    bytes: input.bytes,
    sha256: input.sha256,
    maxBytes: shortsSourceLimit(input),
    format:
      input.processingProfile === SHORTS_ORIGINAL_PROFILE
        ? ('original-file-v1' as const)
        : ('legacy-directory-v1' as const),
  };
}
