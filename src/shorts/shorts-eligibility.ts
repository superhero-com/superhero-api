import type { ShortRecord } from './shorts.types';
import { visualAllows } from './shorts-safety.service';

// Review status is shared by publication, discovery and official delivery.
export function communityGuidelines(
  short: ShortRecord,
  demoAutoApprove = false,
) {
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
  if (demoAutoApprove)
    return { status: 'eligible' as const, approval: 'demo' as const };
  if (short.moderation === 'approved' && visualAllows(short))
    return { status: 'eligible' as const };
  if (!short.safety) return { status: 'analyzing' as const };
  if (short.safety.status === 'error')
    return { status: 'unavailable' as const };
  return { status: 'reviewing' as const };
}

export function officialContentPolicy(
  short: ShortRecord,
  demoAutoApprove = false,
) {
  const allowed =
    short.publication !== 'withdrawn' &&
    communityGuidelines(short, demoAutoApprove).status === 'eligible';
  // Discovery may later be narrower than serving. Neither may bypass safety.
  // Callers must also verify the canonical on-chain publication for delivery.
  return { publish: allowed, serve: allowed, discover: allowed };
}

export function creatorContent(short: ShortRecord, demoAutoApprove = false) {
  const guidelines = communityGuidelines(short, demoAutoApprove);
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
    moderation:
      demoAutoApprove && guidelines.status === 'eligible'
        ? 'approved'
        : short.moderation,
    guidelines,
  };
}
