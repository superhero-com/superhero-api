import { validateOriginalContent } from './shorts-original-content';
import type { ShortRecord } from './shorts.types';

export function shortsDeliverySource(short: ShortRecord) {
  validateOriginalContent(short);
  return { bytes: short.bytes, sha256: short.original.sha256 };
}
