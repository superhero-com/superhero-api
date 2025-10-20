import {
  IParsedPostContent,
  IContentParsingOptions,
} from '../interfaces/post.interfaces';

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

  // Extract media URLs
  const media = extractMedia(mediaArguments, config.maxMediaItems);

  return {
    content: sanitizedContent,
    topics,
    media,
  };
}

/**
 * Normalize topic name according to business rules:
 * - Convert camelCase to kebab-case
 * - Convert to uppercase
 * - Keep all characters (no removal)
 * - Clean up multiple hyphens and leading/trailing hyphens
 */
function normalizeTopic(topic: string): string {
  // Remove the # prefix if present
  const withoutHash = topic.startsWith('#') ? topic.slice(1) : topic;

  // First, convert camelCase to kebab-case
  const kebabCase = withoutHash.replace(/([a-z])([A-Z])/g, '$1-$2');

  // Convert to uppercase (but keep all characters)
  const normalized = kebabCase.toUpperCase();

  // Clean up multiple hyphens and leading/trailing hyphens
  return normalized.replace(/-+/g, '-').replace(/^-|-$/g, '');
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

  const topics = content
    .split(/\s+/)
    .filter((word) => word.startsWith('#') && word.length > 1)
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
    console.warn('Error extracting media from arguments:', error);
    return [];
  }
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
    const isFromMediaHost = commonMediaHosts.some((host) =>
      parsedUrl.hostname.includes(host),
    );

    return hasValidProtocol && (hasMediaExtension || isFromMediaHost);
  } catch {
    return false;
  }
}
