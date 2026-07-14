import { BCL_FACTORY } from '@/configs/contracts';
import {
  TOKEN_HASHTAG_REGEX_SOURCE,
  buildNormalizedTokenMentionSelectSql,
  buildTokenMentionExistsSql,
} from './token-mentions-sql.util';

const HYPHEN = 0x2d;

const matchAll = (content: string): string[] => {
  const matches = content.match(new RegExp(TOKEN_HASHTAG_REGEX_SOURCE, 'g'));
  return (matches ?? []).map((match) => match.slice(1));
};

/** Every codepoint a collection permits, as a flat list. */
const allowedCodepoints = (collection: {
  allowed_name_chars: { [key: string]: number[] }[];
}): number[] => {
  const codepoints: number[] = [];

  for (const entry of collection.allowed_name_chars) {
    if (Array.isArray(entry.SingleChar)) {
      codepoints.push(entry.SingleChar[0]);
    }
    if (Array.isArray(entry.CharRangeFromTo)) {
      codepoints.push(entry.CharRangeFromTo[0], entry.CharRangeFromTo[1]);
    }
  }

  return codepoints;
};

describe('token-mentions-sql util', () => {
  describe('TOKEN_HASHTAG_REGEX_SOURCE', () => {
    it('matches hashtags naming tokens from every non-Latin collection', () => {
      expect(matchAll('look at #汉字 rising')).toEqual(['汉字']);
      expect(matchAll('look at #مرحبا rising')).toEqual(['مرحبا']);
      expect(matchAll('look at #ПРИВЕТ rising')).toEqual(['ПРИВЕТ']);
      expect(matchAll('look at #ЁЛКА rising')).toEqual(['ЁЛКА']);
    });

    it('still matches the Latin hashtags it always did', () => {
      expect(matchAll('buy #WORDS-1 and #beta_2 now')).toEqual([
        'WORDS-1',
        'beta_2',
      ]);
    });

    it('picks up several scripts out of one post', () => {
      expect(matchAll('#汉字 vs #WORDS vs #привет vs #مرحبا')).toEqual([
        '汉字',
        'WORDS',
        'привет',
        'مرحبا',
      ]);
    });

    it('accepts a hyphen inside a symbol but not as its first character', () => {
      expect(matchAll('#WORDS-1')).toEqual(['WORDS-1']);
      expect(matchAll('#-nope')).toEqual([]);
    });

    it('caps a symbol at 50 characters', () => {
      expect(matchAll('#' + 'A'.repeat(50))).toEqual(['A'.repeat(50)]);
      expect(matchAll('#' + 'A'.repeat(60))).toEqual(['A'.repeat(50)]);
      expect(matchAll('#' + '汉'.repeat(60))).toEqual(['汉'.repeat(50)]);
    });

    it('ignores a bare hash', () => {
      expect(matchAll('# not a tag #')).toEqual([]);
    });

    /**
     * The guard that keeps this honest: the class is derived from the factory
     * config, so a collection added later is covered without editing this file —
     * and if its charset somehow is not matched, this fails.
     */
    it('matches a symbol built from any collection the factory allows', () => {
      const collections = Object.values(BCL_FACTORY).flatMap((factory) =>
        Object.values(factory.collections),
      );

      expect(collections.length).toBeGreaterThan(0);

      for (const collection of collections) {
        const symbol = allowedCodepoints(collection)
          .filter((codepoint) => codepoint !== HYPHEN)
          .map((codepoint) => String.fromCodePoint(codepoint))
          .join('');

        expect(matchAll(`mentioning #${symbol} here`)).toEqual([symbol]);

        // People type the symbol in whichever case is convenient; both the JS
        // parser and Postgres UPPER() fold it back to the stored symbol.
        const lowercased = symbol.toLowerCase();
        expect(matchAll(`mentioning #${lowercased} here`)).toEqual([
          lowercased,
        ]);
      }
    });

    /**
     * This exact string is interpolated into Postgres `regexp_matches(...)` as
     * well as passed to `new RegExp(...)`. `\uXXXX` is the only escape both
     * engines read the same way — a JS-only construct (`\p{L}`, `\u{...}`) would
     * still pass the JS tests here while silently matching nothing in SQL.
     */
    it('uses only escape syntax that Postgres and JS both understand', () => {
      expect(TOKEN_HASHTAG_REGEX_SOURCE).toMatch(
        /^#\(\[(?:\\u[0-9A-F]{4}|-)+\]\[(?:\\u[0-9A-F]{4}|-)+\]\{0,49\}\)$/,
      );
      expect(TOKEN_HASHTAG_REGEX_SOURCE).not.toContain('\\p{');
      expect(TOKEN_HASHTAG_REGEX_SOURCE).not.toContain('\\u{');
    });

    it('does not leak an unescaped quote into the SQL string literal', () => {
      expect(TOKEN_HASHTAG_REGEX_SOURCE).not.toContain("'");
    });
  });

  describe('SQL builders', () => {
    it('embeds the shared pattern in the content fallback', () => {
      const sql = buildNormalizedTokenMentionSelectSql('post');

      expect(sql).toContain(`'${TOKEN_HASHTAG_REGEX_SOURCE}'`);
      expect(sql).toContain('UPPER(mention.symbol)');
      expect(sql).toContain('post.token_mentions');
    });

    it('scopes the exists check to the given alias and symbol', () => {
      const sql = buildTokenMentionExistsSql('post', '$2');

      expect(sql).toContain('EXISTS (');
      expect(sql).toContain('normalized_mentions.symbol = $2');
      expect(sql).toContain(`'${TOKEN_HASHTAG_REGEX_SOURCE}'`);
    });
  });
});
