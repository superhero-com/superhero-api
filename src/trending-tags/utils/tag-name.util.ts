/**
 * Trending tags are stored uppercased, so every read has to fold the caller's
 * input the same way the writer did.
 *
 * The character class deliberately admits letters and numbers in any script. A
 * tag is matched against `topic.name` (for the popular-ranking trending boost)
 * and against `token.name` (for the trending-tag → token join), and tokens now
 * come from non-Latin collections — an `[^A-Z0-9-]` strip silently reduced every
 * Chinese, Arabic and Cyrillic tag to the empty string, so it was dropped on
 * ingest and neither of those two consumers could ever see it.
 *
 * Kept in step with `normalizeTopic` in `content-parser.util.ts`: the two must
 * agree on camelCase splitting or a tag will never match its topic.
 */
export function normalizeTagName(tag: string): string {
  return (
    tag
      // camelCase -> kebab-case, in any script that has letter case
      .replace(/(\p{Ll})(\p{Lu})/gu, '$1-$2')
      .toUpperCase()
      .replace(/[^\p{L}\p{N}-]+/gu, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  );
}
