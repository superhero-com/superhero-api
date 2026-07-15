import {
  parsePostContent,
  extractTopics,
  extractTrendMentions,
  extractMedia,
  sanitizeContent,
  isValidMediaUrl,
} from './content-parser.util';

describe('Content Parser Utilities', () => {
  describe('parsePostContent', () => {
    it('should parse content with topics and media', () => {
      const content = 'Hello #world #test this is a post';
      const mediaArguments = [
        { value: 'https://example.com/image.jpg' },
        { value: 'https://example.com/video.mp4' },
      ];

      const result = parsePostContent(content, mediaArguments);

      expect(result.content).toBe(content);
      expect(result.topics).toEqual(['WORLD', 'TEST']);
      expect(result.trendMentions).toEqual(['WORLD', 'TEST']);
      expect(result.media).toEqual([
        'https://example.com/image.jpg',
        'https://example.com/video.mp4',
      ]);
    });

    it('should handle empty content and media', () => {
      const result = parsePostContent('', []);

      expect(result.content).toBe('');
      expect(result.topics).toEqual([]);
      expect(result.trendMentions).toEqual([]);
      expect(result.media).toEqual([]);
    });

    it('should apply custom options', () => {
      const content = '#one #two #three #four #five';
      const options = { maxTopics: 2, sanitizeContent: false };

      const result = parsePostContent(content, [], options);

      expect(result.topics).toHaveLength(2);
    });
  });

  describe('extractTopics', () => {
    it('should extract hashtags from content', () => {
      const content = 'Check out this #awesome #blockchain #dapp';
      const topics = extractTopics(content);

      expect(topics).toEqual(['AWESOME', 'BLOCKCHAIN', 'DAPP']);
    });

    it('should handle mixed case and normalize topics', () => {
      const content = 'Testing #CamelCase #UPPERCASE #lowercase';
      const topics = extractTopics(content);

      expect(topics).toEqual(['CAMEL-CASE', 'UPPERCASE', 'LOWERCASE']);
    });

    it('should filter out invalid hashtags', () => {
      const content = '# #valid_tag #123 #';
      const topics = extractTopics(content);

      expect(topics).toEqual(['VALID_TAG', '123']);
    });

    it('should remove duplicates while preserving order', () => {
      const content = '#first #second #first #third #second';
      const topics = extractTopics(content);

      expect(topics).toEqual(['FIRST', 'SECOND', 'THIRD']);
    });

    it('should respect maxTopics limit', () => {
      const content = '#one #two #three #four #five';
      const topics = extractTopics(content, 3);

      expect(topics).toHaveLength(3);
      expect(topics).toEqual(['ONE', 'TWO', 'THREE']);
    });

    it('should handle empty or invalid input', () => {
      expect(extractTopics('')).toEqual([]);
      expect(extractTopics(null as any)).toEqual([]);
      expect(extractTopics(undefined as any)).toEqual([]);
      expect(extractTopics(123 as any)).toEqual([]);
    });

    it('should filter out very long hashtags', () => {
      const longTag = '#' + 'a'.repeat(60); // 61 characters total
      const validTag = '#valid';
      const content = `${longTag} ${validTag}`;

      const topics = extractTopics(content);

      expect(topics).toEqual(['VALID']);
    });

    it('finds a hashtag with no whitespace before it, as CJK is written', () => {
      // Chinese has no inter-word spaces, so a split-on-whitespace scan sees one
      // long "word" that does not start with '#' and yields nothing.
      expect(extractTopics('我喜欢#汉字')).toEqual(['汉字']);
      expect(extractTopics('看看#汉字，很好')).toEqual(['汉字']);
    });

    it('ends an undelimited hashtag greedily, exactly as it does in ASCII', () => {
      // With no space or punctuation after it there is no boundary to find, so
      // the trailing character is absorbed. This is the same semantics ASCII has
      // always had ('#WORDSfoo' -> 'WORDSFOO'), not a CJK-specific regression.
      expect(extractTopics('看看#汉字和吧')).toEqual(['汉字和吧']);
      expect(extractTopics('buy #WORDSfoo now')).toEqual(['WORDSFOO']);
    });

    it('agrees with extractTrendMentions on which hashtags exist', () => {
      // The two extractors used to disagree for CJK: mentions used a regex scan,
      // topics split on whitespace. They must find the same set.
      for (const content of [
        '我喜欢#汉字',
        '看看#汉字，很好',
        '看看#汉字和吧',
      ]) {
        expect(extractTopics(content)).toEqual(
          extractTrendMentions(content).map((m) => m.toUpperCase()),
        );
      }
    });

    it('drops trailing punctuation so the topic stays addressable', () => {
      // `#汉字。` used to be stored as `汉字。`, which TopicParamPipe rejects with a
      // 400 — the topic existed but its own page was unreachable.
      expect(extractTopics('i like #汉字。 a lot')).toEqual(['汉字']);
      expect(extractTopics('i like #مرحبا؟ a lot')).toEqual(['مرحبا']);
      expect(extractTopics('wow #hello! there')).toEqual(['HELLO']);
    });

    it('produces topic names the topic param validator accepts', () => {
      const TOPIC_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,127}$/u;
      const content =
        '#汉字。 #مرحبا؟ #ПРИВЕТ! #hello! #CamelCase #valid_tag #123 #-lead #_lead';

      const topics = extractTopics(content, 20);

      expect(topics.length).toBeGreaterThan(0);
      for (const topic of topics) {
        expect(TOPIC_PATTERN.test(topic)).toBe(true);
      }
    });
  });

  describe('extractTrendMentions', () => {
    it('extracts token-style mentions and preserves first occurrence order', () => {
      const mentions = extractTrendMentions(
        'Talking about #alpha #MyToken #alpha #my-token #beta_1',
      );

      expect(mentions).toEqual(['ALPHA', 'MYTOKEN', 'MY-TOKEN', 'BETA_1']);
    });

    it('matches hashtags case-insensitively but requires the hash prefix', () => {
      const mentions = extractTrendMentions(
        'alpha #alpha #AlPhA plainToken #plainToken',
      );

      expect(mentions).toEqual(['ALPHA', 'PLAINTOKEN']);
    });

    it('uses different normalization than topics for camel case hashtags', () => {
      expect(extractTopics('Discussing #CamelCase')).toEqual(['CAMEL-CASE']);
      expect(extractTrendMentions('Discussing #CamelCase')).toEqual([
        'CAMELCASE',
      ]);
    });

    it('extracts mentions of tokens from the non-Latin collections', () => {
      expect(extractTrendMentions('buying #汉字 today')).toEqual(['汉字']);
      expect(extractTrendMentions('buying #مرحبا today')).toEqual(['مرحبا']);
      expect(extractTrendMentions('buying #ПРИВЕТ today')).toEqual(['ПРИВЕТ']);
    });

    it('uppercases a Cyrillic mention to the symbol the token is stored under', () => {
      // The RUSSIAN collection only permits А-Я, so the on-chain symbol is
      // uppercase; a lowercase hashtag has to fold onto it to resolve.
      expect(extractTrendMentions('держим #привет крепко')).toEqual(['ПРИВЕТ']);
      expect(extractTrendMentions('и #ёлка тоже')).toEqual(['ЁЛКА']);
    });

    it('extracts Latin and non-Latin mentions from the same post', () => {
      expect(
        extractTrendMentions('swapping #WORDS-1 for #汉字 and #привет'),
      ).toEqual(['WORDS-1', '汉字', 'ПРИВЕТ']);
    });

    it('deduplicates a non-Latin mention repeated in one post', () => {
      expect(extractTrendMentions('#汉字 then #汉字 again')).toEqual(['汉字']);
    });
  });

  describe('extractMedia', () => {
    it('should extract valid media URLs', () => {
      const mediaArguments = [
        { value: 'https://example.com/image.jpg' },
        { value: 'https://example.com/video.mp4' },
        { value: 'not-a-url' },
        { value: null },
      ];

      const media = extractMedia(mediaArguments);

      expect(media).toEqual([
        'https://example.com/image.jpg',
        'https://example.com/video.mp4',
      ]);
    });

    it('should respect maxMediaItems limit', () => {
      const mediaArguments = [
        { value: 'https://example.com/1.jpg' },
        { value: 'https://example.com/2.jpg' },
        { value: 'https://example.com/3.jpg' },
      ];

      const media = extractMedia(mediaArguments, 2);

      expect(media).toHaveLength(2);
    });

    it('should handle invalid input gracefully', () => {
      expect(extractMedia(null as any)).toEqual([]);
      expect(extractMedia(undefined as any)).toEqual([]);
      expect(extractMedia('not-array' as any)).toEqual([]);
    });

    it('should handle extraction errors', () => {
      const mediaArguments = [
        {
          value: {
            toString: () => {
              throw new Error('Test error');
            },
          },
        },
        { value: 'https://example.com/valid.jpg' },
      ];

      const media = extractMedia(mediaArguments);

      expect(media).toEqual(['https://example.com/valid.jpg']);
    });
  });

  describe('sanitizeContent', () => {
    it('should trim whitespace', () => {
      const content = '   Hello world   ';
      const sanitized = sanitizeContent(content);

      expect(sanitized).toBe('Hello world');
    });

    it('should normalize line endings', () => {
      const content = 'Line 1\r\nLine 2\r\nLine 3';
      const sanitized = sanitizeContent(content);

      expect(sanitized).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should limit consecutive line breaks', () => {
      const content = 'Line 1\n\n\n\n\nLine 2';
      const sanitized = sanitizeContent(content);

      expect(sanitized).toBe('Line 1\n\nLine 2');
    });

    it('should enforce maximum length', () => {
      const content = 'a'.repeat(6000);
      const sanitized = sanitizeContent(content);

      expect(sanitized).toHaveLength(5000);
    });

    it('should handle invalid input', () => {
      expect(sanitizeContent(null as any)).toBe('');
      expect(sanitizeContent(undefined as any)).toBe('');
      expect(sanitizeContent(123 as any)).toBe('');
    });
  });

  describe('isValidMediaUrl', () => {
    it('should validate URLs with media extensions', () => {
      const validUrls = [
        'https://example.com/image.jpg',
        'http://example.com/image.jpeg',
        'https://example.com/image.png',
        'https://example.com/image.gif',
        'https://example.com/image.webp',
        'https://example.com/video.mp4',
        'https://example.com/video.webm',
        'https://example.com/video.mov',
      ];

      validUrls.forEach((url) => {
        expect(isValidMediaUrl(url)).toBe(true);
      });
    });

    it('should validate URLs from known media hosts', () => {
      const mediaHostUrls = [
        'https://imgur.com/gallery/abc123',
        'https://giphy.com/gifs/abc123',
        'https://youtube.com/watch?v=abc123',
        'https://vimeo.com/123456789',
        'https://i.imgur.com/abc123',
      ];

      mediaHostUrls.forEach((url) => {
        expect(isValidMediaUrl(url)).toBe(true);
      });
    });

    it('should reject invalid URLs', () => {
      const invalidUrls = [
        'not-a-url',
        'ftp://example.com/file.jpg',
        'https://example.com/document.pdf',
        'https://example.com/page.html',
        '',
        null,
        undefined,
      ];

      invalidUrls.forEach((url) => {
        expect(isValidMediaUrl(url as any)).toBe(false);
      });
    });

    it('should handle malformed URLs gracefully', () => {
      const malformedUrls = [
        'https://',
        'https://.',
        'https://example',
        'https://example.',
        'javascript:alert(1)',
      ];

      malformedUrls.forEach((url) => {
        expect(isValidMediaUrl(url)).toBe(false);
      });
    });

    it('should require valid protocols', () => {
      expect(isValidMediaUrl('ftp://example.com/image.jpg')).toBe(false);
      expect(isValidMediaUrl('file:///local/image.jpg')).toBe(false);
      expect(isValidMediaUrl('data:image/png;base64,abc')).toBe(false);
    });
  });
});

/**
 * Additional test cases to consider:
 *
 * 1. Edge cases:
 *    - Very large content strings
 *    - Unicode characters in hashtags
 *    - International domain names
 *    - URL encoding in media URLs
 *
 * 2. Security tests:
 *    - XSS prevention in content
 *    - Malicious URL detection
 *    - Script injection attempts
 *
 * 3. Performance tests:
 *    - Large number of hashtags
 *    - Large media arrays
 *    - Complex regex patterns
 *
 * 4. Integration tests:
 *    - Real-world content examples
 *    - Multi-language content
 *    - Mixed content types
 */
