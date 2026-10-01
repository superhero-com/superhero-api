import type { ShortRecord } from './shorts.types';
import { visualAllows } from './shorts-safety.service';

// Feed distribution is a separate decision from purchased storage coverage.
export function communityGuidelines(short: ShortRecord) {
  if (short.moderation === 'rejected' || short.safety?.status === 'blocked') {
    const decision = short.reviewHistory?.at(-1);
    return {
      status: 'ineligible' as const,
      reason:
        decision &&
        !decision.approved &&
        decision.at >= (short.safety?.checkedAt || 0)
          ? decision.reason
          : undefined,
    };
  }
  if (short.moderation === 'approved' && visualAllows(short))
    return { status: 'eligible' as const };
  if (!short.safety) return { status: 'analyzing' as const };
  if (short.safety.status === 'error')
    return { status: 'unavailable' as const };
  return { status: 'reviewing' as const };
}

export function creatorContent(short: ShortRecord) {
  return {
    id: short.id,
    creator: short.creator,
    title: short.title,
    topic: short.reviewedTopic || short.topic,
    cid: short.cid,
    bytes: short.bytes,
    duration: short.duration,
    createdAt: short.createdAt,
    description: short.description,
    language: short.language,
    synthetic: short.synthetic,
    sponsored: short.sponsored,
    moderation: short.moderation,
    guidelines: communityGuidelines(short),
  };
}
