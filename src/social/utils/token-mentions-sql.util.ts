import { Logger } from '@nestjs/common';
import { BCL_FACTORY } from '@/configs/contracts';

const logger = new Logger('TokenMentionsSqlUtil');

/**
 * A BCL token's symbol is its on-chain community name verbatim, and each factory
 * collection declares exactly which characters such a name may contain
 * (`allowed_name_chars`). The hashtag character class is therefore derived from
 * that config instead of being hardcoded: adding a collection (CHINESE, ARABIC,
 * RUSSIAN, ...) makes its tokens mentionable without touching this file.
 *
 * The source string below is consumed verbatim by two regex engines — JS
 * `RegExp` and Postgres ARE (`regexp_matches`) — so every codepoint is emitted
 * as a `\uXXXX` escape. That is the one form both engines read identically, and
 * it keeps regex-special characters (`-`, `]`, `^`) from ever landing in the
 * bracket expression raw.
 */

/** Inclusive `[start, end]` codepoint interval. */
type CodepointRange = [number, number];

/** Accepted long before collections existed; kept so old mentions still parse. */
const UNDERSCORE = 0x5f;

/** Legal inside a symbol, never as its first character. */
const HYPHEN = 0x2d;

/** Total symbol length cap (first character + tail). */
const MAX_SYMBOL_LENGTH = 50;

/** A `\uXXXX` escape is exactly 4 hex digits in both engines. */
const BMP_MAX = 0xffff;

/**
 * Every codepoint any collection permits, across every network.
 */
function collectionRanges(): CodepointRange[] {
  const ranges: CodepointRange[] = [[UNDERSCORE, UNDERSCORE]];

  for (const factory of Object.values(BCL_FACTORY)) {
    for (const collection of Object.values(factory.collections ?? {})) {
      for (const entry of collection.allowed_name_chars ?? []) {
        const single = entry.SingleChar;
        if (Array.isArray(single) && single.length > 0) {
          ranges.push([single[0], single[0]]);
        }

        const range = entry.CharRangeFromTo;
        if (Array.isArray(range) && range.length > 1) {
          ranges.push([range[0], range[1]]);
        }
      }
    }
  }

  return ranges;
}

/**
 * Collections declare the *stored* casing (WORDS allows `A-Z`, RUSSIAN `А-Я`),
 * but people type `#words` and `#привет`. Both the JS parser and Postgres
 * `UPPER()` fold a mention up to the stored symbol, so the class has to admit
 * either case on the way in.
 */
function withCaseCounterparts(ranges: CodepointRange[]): CodepointRange[] {
  const expanded: CodepointRange[] = [...ranges];

  for (const [start, end] of ranges) {
    for (let codepoint = start; codepoint <= end; codepoint++) {
      const character = String.fromCodePoint(codepoint);

      for (const variant of [
        character.toLowerCase(),
        character.toUpperCase(),
      ]) {
        // Some characters case-fold to multiple characters (ß -> SS); such a
        // fold has no single codepoint to add to the class.
        if (variant.length === 1 && variant !== character) {
          const variantCodepoint = variant.codePointAt(0) as number;
          expanded.push([variantCodepoint, variantCodepoint]);
        }
      }
    }
  }

  return expanded;
}

/** Sorts and coalesces overlapping or adjacent intervals. */
function mergeRanges(ranges: CodepointRange[]): CodepointRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: CodepointRange[] = [];

  for (const [start, end] of sorted) {
    const previous = merged[merged.length - 1];

    if (previous && start <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], end);
      continue;
    }

    merged.push([start, end]);
  }

  return merged;
}

/**
 * Astral codepoints would need `\u{...}` in JS but `\Uxxxxxxxx` in Postgres, so
 * there is no shared escape for them. No collection uses any today; warn loudly
 * rather than silently failing to match if one ever does.
 */
function toBasicMultilingualPlane(ranges: CodepointRange[]): CodepointRange[] {
  const kept: CodepointRange[] = [];
  let dropped = false;

  for (const [start, end] of ranges) {
    if (start > BMP_MAX) {
      dropped = true;
      continue;
    }

    if (end > BMP_MAX) {
      dropped = true;
      kept.push([start, BMP_MAX]);
      continue;
    }

    kept.push([start, end]);
  }

  if (dropped) {
    logger.warn(
      'A BCL collection allows codepoints above U+FFFF. Hashtags using them will not be indexed: ' +
        'JS and Postgres have no common escape syntax for astral codepoints.',
    );
  }

  return kept;
}

/** Removes a single codepoint from a set of intervals, splitting where needed. */
function withoutCodepoint(
  ranges: CodepointRange[],
  codepoint: number,
): CodepointRange[] {
  const remaining: CodepointRange[] = [];

  for (const [start, end] of ranges) {
    if (codepoint < start || codepoint > end) {
      remaining.push([start, end]);
      continue;
    }

    if (start <= codepoint - 1) {
      remaining.push([start, codepoint - 1]);
    }

    if (codepoint + 1 <= end) {
      remaining.push([codepoint + 1, end]);
    }
  }

  return remaining;
}

const escapeCodepoint = (codepoint: number): string =>
  `\\u${codepoint.toString(16).toUpperCase().padStart(4, '0')}`;

/** Renders intervals as the inside of a bracket expression, fully escaped. */
function toCharClass(ranges: CodepointRange[]): string {
  return ranges
    .map(([start, end]) =>
      start === end
        ? escapeCodepoint(start)
        : `${escapeCodepoint(start)}-${escapeCodepoint(end)}`,
    )
    .join('');
}

const ALLOWED_RANGES = mergeRanges(
  toBasicMultilingualPlane(
    withCaseCounterparts(mergeRanges(collectionRanges())),
  ),
);

const TAIL_CLASS = toCharClass(ALLOWED_RANGES);
const FIRST_CLASS = toCharClass(withoutCodepoint(ALLOWED_RANGES, HYPHEN));

export const TOKEN_HASHTAG_REGEX_SOURCE = `#([${FIRST_CLASS}][${TAIL_CLASS}]{0,${
  MAX_SYMBOL_LENGTH - 1
}})`;

export function buildNormalizedTokenMentionSelectSql(
  postAlias: string,
): string {
  return `
    SELECT DISTINCT UPPER(mention.symbol) AS symbol
    FROM (
      SELECT jsonb_array_elements_text(
        COALESCE(${postAlias}.token_mentions, '[]'::jsonb)
      ) AS symbol
      UNION ALL
      SELECT content_match[1] AS symbol
      FROM regexp_matches(
        COALESCE(${postAlias}.content, ''),
        '${TOKEN_HASHTAG_REGEX_SOURCE}',
        'g'
      ) AS content_match
      WHERE jsonb_array_length(COALESCE(${postAlias}.token_mentions, '[]'::jsonb)) = 0
    ) mention
    WHERE mention.symbol IS NOT NULL
      AND mention.symbol <> ''
  `;
}

/**
 * Checks whether `postAlias` mentions `normalizedSymbolSql` (an already
 * UPPER()-cased symbol expression or bind parameter). Stored `token_mentions`
 * entries are always upper-cased at write time (`extractTrendMentions`), so
 * the common case is a plain jsonb containment check — servable by
 * `IDX_POSTS_TOKEN_MENTIONS_GIN` (`jsonb_path_ops`) instead of the per-row
 * `jsonb_array_elements_text` scan the old EXISTS subquery required. The
 * regex-over-`content` fallback only runs for the (increasingly rare) rows
 * where `token_mentions` was never populated.
 *
 * The containment predicate below deliberately does NOT wrap `token_mentions`
 * in `COALESCE(...)` (the column is `NOT NULL DEFAULT '[]'`, so it's never
 * needed) — Postgres only matches a GIN index to a query predicate that is
 * shaped exactly like the indexed expression, so wrapping the column here
 * would silently defeat `IDX_POSTS_TOKEN_MENTIONS_GIN` and fall back to a
 * full scan.
 */
export function buildTokenMentionExistsSql(
  postAlias: string,
  normalizedSymbolSql: string,
): string {
  return `
    (
      ${postAlias}.token_mentions
        @> jsonb_build_array((${normalizedSymbolSql})::text)
      OR (
        jsonb_array_length(COALESCE(${postAlias}.token_mentions, '[]'::jsonb)) = 0
        AND EXISTS (
          SELECT 1
          FROM regexp_matches(
            COALESCE(${postAlias}.content, ''),
            '${TOKEN_HASHTAG_REGEX_SOURCE}',
            'g'
          ) AS content_match
          WHERE UPPER(content_match[1]) = ${normalizedSymbolSql}
        )
      )
    )
  `;
}
