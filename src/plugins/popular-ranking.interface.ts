import { PopularWindow } from '../social/services/popular-ranking.service';

/**
 * Represents a content item that can be ranked in the popular feed.
 * This is a virtual post-like structure that plugins can provide.
 */
export interface PopularRankingContentItem {
  /**
   * Unique identifier for this content item.
   * Should be prefixed with plugin name, e.g., "poll:123" or "poll:hash_abc"
   */
  id: string;

  /**
   * Type discriminator to identify the content type (e.g., "poll", "post", etc.)
   */
  type: string;

  /**
   * Creation timestamp
   */
  created_at: Date;

  /**
   * Author/creator address
   */
  sender_address: string;

  /**
   * Content text (for content quality scoring)
   */
  content: string;

  /**
   * Number of comments (or equivalent engagement metric)
   * For polls, this could be votes_count
   */
  total_comments: number;

  /**
   * Topics/tags associated with this content
   */
  topics?: Array<{ name: string }>;

  /**
   * Additional metadata specific to the content type
   */
  metadata?: Record<string, any>;
}

/**
 * Interface for plugins to contribute content to the popular ranking system.
 * Plugins implementing this interface can have their content included in the popular feed.
 */
export interface PopularRankingContributor {
  /**
   * Name of the plugin (should match plugin name)
   */
  readonly name: string;

  /**
   * Fetch candidate content items for ranking within the specified time window.
   * @param window - Time window for ranking (24h, 7d, or all)
   * @param since - Earliest date to include (null for 'all' window)
   * @param limit - Maximum number of items to return
   * @returns Array of content items ready for ranking
   */
  getRankingCandidates(
    window: PopularWindow,
    since: Date | null,
    limit: number,
  ): Promise<PopularRankingContentItem[]>;
}
