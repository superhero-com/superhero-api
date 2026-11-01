/**
 * Accounts tagged in post content with the client mention macro
 * `[account:ak_…]` (see superhero `features/social/utils/mentions.ts`).
 * Raw `ak_` addresses in text are not mentions. Returns unique addresses in
 * order of first appearance, capped so one post can't page hundreds of users.
 */
export const MAX_NOTIFIED_MENTIONS = 10;

const ACCOUNT_MENTION_RE = /\[account:(ak_[1-9A-HJ-NP-Za-km-z]{38,60})\]/g;

export function extractAccountMentions(
  content: string | null | undefined,
  limit = MAX_NOTIFIED_MENTIONS,
): string[] {
  if (!content || typeof content !== 'string') {
    return [];
  }
  const seen = new Set<string>();
  for (const match of content.matchAll(ACCOUNT_MENTION_RE)) {
    seen.add(match[1]);
    if (seen.size >= limit) {
      break;
    }
  }
  return [...seen];
}
