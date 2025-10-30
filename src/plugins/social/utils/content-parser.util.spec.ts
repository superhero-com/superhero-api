import {
  parsePostContent,
  extractTopics,
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
      expect(result.topics).toEqual(['#world', '#test']);
      expect(result.media).toEqual([
        'https://example.com/image.jpg',
        'https://example.com/video.mp4',
      ]);
    });

    it('should handle empty content and media', () => {
      const result = parsePostContent('', []);

      expect(result.content).toBe('');
      expect(result.topics).toEqual([]);
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

      expect(topics).toEqual(['#awesome', '#blockchain', '#dapp']);
    });

    it('should handle mixed case and convert to lowercase', () => {
      const content = 'Testing #CamelCase #UPPERCASE #lowercase';
      const topics = extractTopics(content);

      expect(topics).toEqual(['#camelcase', '#uppercase', '#lowercase']);
    });

    it('should filter out invalid hashtags', () => {
      const content = '# #valid_tag #123 #';
      const topics = extractTopics(content);

      expect(topics).toEqual(['#valid_tag', '#123']);
    });

    it('should remove duplicates while preserving order', () => {
      const content = '#first #second #first #third #second';
      const topics = extractTopics(content);

      expect(topics).toEqual(['#first', '#second', '#third']);
    });

    it('should respect maxTopics limit', () => {
      const content = '#one #two #three #four #five';
      const topics = extractTopics(content, 3);

      expect(topics).toHaveLength(3);
      expect(topics).toEqual(['#one', '#two', '#three']);
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

      expect(topics).toEqual(['#valid']);
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
