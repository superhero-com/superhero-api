import { normalizeTagName } from './tag-name.util';
import { extractTopics } from '@/social/utils/content-parser.util';
import { normalizeTopicName } from '@/social/utils/topic-name.util';

describe('normalizeTagName', () => {
  it('keeps tags from the non-Latin collections instead of emptying them', () => {
    // The old `[^A-Z0-9-]` strip reduced each of these to '', so ingest skipped
    // the tag entirely and it could never reach a topic or a token.
    expect(normalizeTagName('汉字')).toBe('汉字');
    expect(normalizeTagName('مرحبا')).toBe('مرحبا');
    expect(normalizeTagName('ПРИВЕТ')).toBe('ПРИВЕТ');
  });

  it('uppercases so the tag matches the symbol the token is stored under', () => {
    expect(normalizeTagName('привет')).toBe('ПРИВЕТ');
    expect(normalizeTagName('words-1')).toBe('WORDS-1');
  });

  it('still normalizes Latin tags the way it always did', () => {
    expect(normalizeTagName('CamelCase')).toBe('CAMEL-CASE');
    expect(normalizeTagName('UPPERCASE')).toBe('UPPERCASE');
    expect(normalizeTagName('--messy--tag--')).toBe('MESSY-TAG');
  });

  it('drops punctuation and emoji a tag may not contain', () => {
    expect(normalizeTagName('汉字。')).toBe('汉字');
    expect(normalizeTagName('hello!')).toBe('HELLO');
    expect(normalizeTagName('dog🐶')).toBe('DOG');
  });

  it('returns empty for a tag with nothing usable left', () => {
    expect(normalizeTagName('!!!')).toBe('');
    expect(normalizeTagName('')).toBe('');
  });

  /**
   * PopularRankingService keys its trending-tag cache on `tag.toLowerCase()` and
   * looks it up with `topic.name.toLowerCase()`. If the tag normalizer and the
   * topic normalizer ever disagree, the trending boost silently reads 0 for
   * every affected topic — no error, just worse ranking. This pins them together.
   */
  describe('agrees with topic normalization, so the trending boost can match', () => {
    const topicKeyFor = (hashtagBody: string) => {
      const [topic] = extractTopics(`#${hashtagBody}`);
      return normalizeTopicName(topic);
    };

    it.each([
      ['汉字'],
      ['مرحبا'],
      ['привет'],
      ['ПРИВЕТ'],
      ['ёлка'],
      ['WORDS-1'],
      ['CamelCase'],
    ])('tag %s keys the same as its topic', (raw) => {
      const tagKey = normalizeTagName(raw).toLowerCase();

      expect(tagKey).not.toBe('');
      expect(tagKey).toBe(topicKeyFor(raw));
    });
  });

  /**
   * The trending-tags controller joins `token.name = trending_tag.tag`. Tokens
   * store the on-chain name verbatim, and the collections only permit uppercase
   * (A-Z, А-Я) or caseless scripts — so a normalized tag has to come out equal to
   * the symbol, or the join never resolves.
   */
  it('produces exactly the symbol a token is stored under', () => {
    expect(normalizeTagName('привет')).toBe('ПРИВЕТ'); // RUSSIAN collection
    expect(normalizeTagName('汉字')).toBe('汉字'); // CHINESE (caseless)
    expect(normalizeTagName('مرحبا')).toBe('مرحبا'); // ARABIC (caseless)
    expect(normalizeTagName('words-1')).toBe('WORDS-1'); // WORDS
  });
});
