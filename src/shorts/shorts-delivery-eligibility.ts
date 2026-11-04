import { NotFoundException } from '@nestjs/common';
import { officialContentPolicy } from './shorts-eligibility';
import { validateOriginalContent } from './shorts-original-content';
import { shortsDeliverySource } from './shorts-delivery-source';
import type { ShortRecord } from './shorts.types';

/** Re-encoding the same reviewed post is not approval for changed content. */
export function assertDeliveryEligible(
  original: ShortRecord,
  candidate: ShortRecord,
) {
  let source: ReturnType<typeof shortsDeliverySource>;
  try {
    source = shortsDeliverySource(original);
  } catch {
    throw new NotFoundException('Delivery source is unavailable');
  }
  const metadata = (record: ShortRecord) => [
    record.creator,
    record.title,
    record.topic,
    record.description || '',
    record.language || 'und',
    record.synthetic === true,
    record.sponsored === true,
    record.captions === true,
    record.duration,
  ];
  const captions = (record: ShortRecord) => {
    const file = record.files.find((entry) => entry.name === 'captions.vtt');
    return file ? [file.bytes, file.sha256] : null;
  };
  if (
    !validateOriginalContent(candidate) ||
    original.publication !== 'published' ||
    !officialContentPolicy(original).serve ||
    original.safety?.sourceSha256 !== source.sha256 ||
    candidate.publication !== undefined ||
    candidate.moderation !== 'pending' ||
    candidate.safety?.status !== 'no_flags' ||
    candidate.safety.sourceSha256 !== source.sha256 ||
    candidate.bytes !== source.bytes ||
    candidate.original.sha256 !== source.sha256 ||
    (source.kind === 'published-file' &&
      (candidate.cid !== original.cid ||
        candidate.original.mediaType !== original.original.mediaType)) ||
    JSON.stringify(metadata(original)) !==
      JSON.stringify(metadata(candidate)) ||
    JSON.stringify(captions(original)) !== JSON.stringify(captions(candidate))
  )
    throw new NotFoundException('Delivery generation is not eligible');
}

/** Original-only lifecycle operations must not inherit legacy selection authority. */
export function assertOriginalDeliveryEligible(
  original: ShortRecord,
  candidate: ShortRecord,
) {
  if (!validateOriginalContent(original))
    throw new NotFoundException('Original delivery required');
  return assertDeliveryEligible(original, candidate);
}
