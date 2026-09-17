/**
 * Local, dependency-free language/script tagging for post content.
 *
 * Returns one of the four scripts the app's language switcher supports, or
 * `und` when no supported script is present. `en` means "Latin script", which
 * matches the switcher's English/Latin option. There is no LLM and no network
 * call: the whole decision is character-range counting, so the same function
 * runs on the insert path and in the backfill script and always agrees.
 *
 * Known, accepted limits: Japanese kanji reads as `zh`; Ukrainian and
 * Bulgarian as `ru`; Persian and Urdu as `ar`; Korean as `und` (or `en` when
 * it also carries Latin letters).
 */
export type PostLanguage = 'en' | 'zh' | 'ar' | 'ru' | 'und';

/** Every value the detector may store in `posts.language`. */
export const POST_LANGUAGES: readonly PostLanguage[] = [
  'en',
  'zh',
  'ar',
  'ru',
  'und',
];

/**
 * Values the content-language filter accepts. `und` and `null` are never
 * matched by a filter, so they are absent here.
 */
export const POST_LANGUAGE_FILTERS = ['en', 'zh', 'ar', 'ru'] as const;
export type PostLanguageFilter = (typeof POST_LANGUAGE_FILTERS)[number];

// Links and tickers are written in Latin letters in every language, so left in
// they would push every post towards `en`. Strip URLs, æternity chain ids and
// Latin @/# tags before counting. Non-Latin tags (e.g. `#比特币`) carry no Latin
// letters, do not match the Latin-tag pattern, and are kept and counted.
const URL_RE = /https?:\/\/\S+|www\.\S+/giu;
const CHAIN_ID_RE = /\b(?:ak|ct|th|ok|nm|ch)_[1-9A-HJ-NP-Za-km-z]+/gu;
const LATIN_TAG_RE = /[@#][A-Za-z0-9_.-]+/gu;

const HAN_RE = /\p{Script=Han}/gu;
const ARABIC_RE = /\p{Script=Arabic}/gu;
const CYRILLIC_RE = /\p{Script=Cyrillic}/gu;
const LATIN_RE = /\p{Script=Latin}/gu;

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

export function detectPostLanguage(
  content: string | null | undefined,
): PostLanguage {
  if (!content) {
    return 'und';
  }

  const stripped = content
    .replace(URL_RE, ' ')
    .replace(CHAIN_ID_RE, ' ')
    .replace(LATIN_TAG_RE, ' ');

  const latin = countMatches(stripped, LATIN_RE);

  // Strongest non-Latin script wins; on a tie the order is zh, ar, ru.
  const nonLatin: Array<[PostLanguage, number]> = [
    ['zh', countMatches(stripped, HAN_RE)],
    ['ar', countMatches(stripped, ARABIC_RE)],
    ['ru', countMatches(stripped, CYRILLIC_RE)],
  ];
  let best = nonLatin[0];
  for (const candidate of nonLatin) {
    if (candidate[1] > best[1]) {
      best = candidate;
    }
  }

  // A non-Latin character is roughly one word where a Latin word is 4-5
  // letters, and Latin text inside a non-Latin post here is usually tickers and
  // crypto terms, so scale the non-Latin count by 4 before comparing.
  if (best[1] > 0 && best[1] * 4 >= latin) {
    return best[0];
  }

  return latin > 0 ? 'en' : 'und';
}
