import {
  IParsedPostContent,
  IContentParsingOptions,
} from '../interfaces/post.interfaces';
import { TOKEN_HASHTAG_REGEX_SOURCE } from './token-mentions-sql.util';
import { Logger } from '@nestjs/common';

const logger = new Logger('ContentParserUtil');

/**
 * Default options for content parsing
 */
const DEFAULT_PARSING_OPTIONS: Required<IContentParsingOptions> = {
  maxTopics: 10,
  maxMediaItems: 5,
  sanitizeContent: true,
};

/**
 * Parses post content and extracts topics and media
 */
export function parsePostContent(
  content: string,
  mediaArguments: any[] = [],
  options: IContentParsingOptions = {},
): IParsedPostContent {
  const config = { ...DEFAULT_PARSING_OPTIONS, ...options };

  // Sanitize content if requested
  const sanitizedContent = config.sanitizeContent
    ? sanitizeContent(content)
    : content;

  // Extract topics (hashtags)
  const topics = extractTopics(sanitizedContent, config.maxTopics);
  const trendMentions = extractTrendMentions(
    sanitizedContent,
    config.maxTopics,
  );

  // Extract media URLs
  const media = extractMedia(mediaArguments, config.maxMediaItems);

  return {
    content: sanitizedContent,
    topics,
    media,
    trendMentions,
  };
}

/**
 * A hashtag, scanned rather than split on whitespace: Chinese is written without
 * spaces, so `我喜欢#汉字` has no whitespace-delimited word starting with `#` and a
 * split-based scan finds nothing — while `extractTrendMentions` (a real regex
 * scan) does find the token. The two extractors have to agree.
 *
 * The body is exactly what `TOPIC_PATTERN` in the request validation accepts, so
 * a topic we store is always addressable at `/topics/name/:name`.
 */
const TOPIC_HASHTAG_PATTERN = /#([\p{L}\p{N}][\p{L}\p{N}_.-]*)/gu;

/** Characters `TOPIC_PATTERN` would reject, e.g. `。`, `؟`, `!`, emoji. */
const TOPIC_DISALLOWED_CHARS = /[^\p{L}\p{N}_.-]+/gu;

/**
 * Normalize topic name according to business rules:
 * - Convert camelCase to kebab-case
 * - Convert to uppercase
 * - Drop characters a topic name may not contain
 * - Clean up hyphens, and ensure it starts with a letter or number
 */
function normalizeTopic(topic: string): string {
  // Remove the # prefix if present
  const withoutHash = topic.startsWith('#') ? topic.slice(1) : topic;

  // camelCase -> kebab-case, in any script that has letter case. Must stay in
  // step with `normalizeTagName`, or a trending tag never matches its topic.
  const kebabCase = withoutHash.replace(/(\p{Ll})(\p{Lu})/gu, '$1-$2');

  return (
    kebabCase
      .toUpperCase()
      // CJK/Arabic terminal punctuation clings to a hashtag (there is no
      // separating space), so `#汉字。` would otherwise be stored as `汉字。` — a
      // name TopicParamPipe rejects, making the topic's own page 400.
      .replace(TOPIC_DISALLOWED_CHARS, '')
      .replace(/-+/g, '-')
      .replace(/^[_.-]+/, '')
      .replace(/-$/, '')
  );
}

/**
 * Extracts hashtags from content
 */
export function extractTopics(
  content: string,
  maxTopics: number = 10,
): string[] {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const topics = (content.match(TOPIC_HASHTAG_PATTERN) ?? [])
    .map((topic) => normalizeTopic(topic))
    .filter((topic) => topic.length > 0 && topic.length <= 50) // Reasonable length limits
    .slice(0, maxTopics);

  // Remove duplicates while preserving order
  return [...new Set(topics)];
}

/**
 * Extracts media URLs from transaction arguments
 */
export function extractMedia(
  mediaArguments: any[] = [],
  maxMediaItems: number = 5,
): string[] {
  if (!Array.isArray(mediaArguments)) {
    return [];
  }

  try {
    const media = mediaArguments
      .map((item) => item?.value)
      .filter((value) => value && typeof value === 'string')
      .filter((url) => isValidMediaUrl(url))
      .slice(0, maxMediaItems);

    return media;
  } catch (error) {
    logger.warn('Error extracting media from arguments', error);
    return [];
  }
}

/**
 * Extracts #trend mentions from content
 */
export function extractTrendMentions(
  content: string,
  maxMentions: number = 10,
): string[] {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const tokenMentionPattern = new RegExp(TOKEN_HASHTAG_REGEX_SOURCE, 'g');
  const mentions: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = tokenMentionPattern.exec(content)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }

    const normalized = raw.toUpperCase();
    if (normalized.length === 0 || normalized.length > 50) {
      continue;
    }

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    mentions.push(normalized);
    if (mentions.length >= maxMentions) {
      break;
    }
  }

  // Remove duplicates while preserving order
  return [...new Set(mentions)];
}

/**
 * Basic content sanitization
 */
export function sanitizeContent(content: string): string {
  if (!content || typeof content !== 'string') {
    return '';
  }

  return content
    .trim()
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/\n{3,}/g, '\n\n') // Limit consecutive line breaks
    .slice(0, 5000); // Reasonable length limit
}

/**
 * Validates if a URL appears to be a valid media URL
 */
export function isValidMediaUrl(url: string): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    const validProtocols = ['http:', 'https:'];
    const mediaExtensions = [
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.webp',
      '.mp4',
      '.webm',
      '.mov',
    ];

    const hasValidProtocol = validProtocols.includes(parsedUrl.protocol);
    const hasMediaExtension = mediaExtensions.some((ext) =>
      parsedUrl.pathname.toLowerCase().endsWith(ext),
    );

    // Allow URLs from common media hosting services even without explicit extensions
    const commonMediaHosts = [
      'imgur.com',
      'giphy.com',
      'youtube.com',
      'vimeo.com',
    ];
    const hostname = parsedUrl.hostname.toLowerCase();
    const isFromMediaHost = commonMediaHosts.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`),
    );

    return hasValidProtocol && (hasMediaExtension || isFromMediaHost);
  } catch {
    return false;
  }
}
