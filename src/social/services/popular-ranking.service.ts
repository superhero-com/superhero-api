import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Post } from '../entities/post.entity';
import { Tip } from '@/tipping/entities/tip.entity';
import { TrendingTag } from '@/trending-tags/entities/trending-tags.entity';
import { POPULAR_RANKING_CONFIG } from '@/configs/constants';
import Redis from 'ioredis';
import { REDIS_CONFIG } from '@/configs/redis';
import { PostReadsDaily } from '../entities/post-reads.entity';
import {
  PopularRankingContributor,
  PopularRankingContentItem,
} from '@/plugins/popular-ranking.interface';
import { Inject, Optional } from '@nestjs/common';
import { POPULAR_RANKING_CONTRIBUTOR } from '@/plugins/plugin.tokens';

export type PopularWindow = '24h' | '7d' | 'all';

interface PopularScoreItem {
  postId: string;
  score: number;
  type?: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class PopularRankingService {
  private readonly logger = new Logger(PopularRankingService.name);
  private readonly redis = new Redis(REDIS_CONFIG);

  constructor(
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
    @InjectRepository(Tip)
    private readonly tipRepository: Repository<Tip>,
    @InjectRepository(TrendingTag)
    private readonly trendingTagRepository: Repository<TrendingTag>,
    @InjectRepository(PostReadsDaily)
    private readonly postReadsRepository: Repository<PostReadsDaily>,
    @Optional()
    @Inject(POPULAR_RANKING_CONTRIBUTOR)
    private readonly rankingContributors: PopularRankingContributor[] = [],
  ) {}

  private getWindowHours(window: PopularWindow): number {
    if (window === '24h') {
      return POPULAR_RANKING_CONFIG.WINDOW_24H_HOURS;
    }
    if (window === '7d') {
      return POPULAR_RANKING_CONFIG.WINDOW_7D_HOURS;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  private getRedisKey(window: PopularWindow): string {
    if (window === '24h') {
      return POPULAR_RANKING_CONFIG.REDIS_KEYS.popular24h;
    }
    if (window === '7d') {
      return POPULAR_RANKING_CONFIG.REDIS_KEYS.popular7d;
    }
    return POPULAR_RANKING_CONFIG.REDIS_KEYS.popularAll;
  }

  /**
   * Get verified popular post IDs from Redis, ensuring they exist in DB
   */
  private async getVerifiedPopularIds(
    window: PopularWindow,
    maxCandidates?: number,
  ): Promise<string[]> {
    const key = this.getRedisKey(window);

    let popularRanks = new Map<string, number>();
    try {
      const totalPopular = await this.redis.zcard(key);
      if (totalPopular > 0) {
        const cached = await this.redis.zrevrange(
          key,
          0,
          totalPopular - 1,
          'WITHSCORES',
        );
        for (let i = 0; i < cached.length; i += 2) {
          popularRanks.set(cached[i], parseFloat(cached[i + 1]));
        }
      }
    } catch (error) {
      this.logger.error(`Error loading from Redis:`, error);
      popularRanks = new Map();
    }

    if (popularRanks.size === 0) {
      const fallbackMax =
        window === 'all'
          ? POPULAR_RANKING_CONFIG.MAX_CANDIDATES_ALL
          : window === '7d'
            ? POPULAR_RANKING_CONFIG.MAX_CANDIDATES_7D
            : POPULAR_RANKING_CONFIG.MAX_CANDIDATES_24H;
      try {
        await this.recompute(window, maxCandidates ?? fallbackMax);
        const totalPopular = await this.redis.zcard(key);
        if (totalPopular > 0) {
          const cached = await this.redis.zrevrange(
            key,
            0,
            totalPopular - 1,
            'WITHSCORES',
          );
          for (let i = 0; i < cached.length; i += 2) {
            popularRanks.set(cached[i], parseFloat(cached[i + 1]));
          }
          this.logger.log(
            `Recomputed popular posts for window ${window}: ${totalPopular} posts cached`,
          );
        } else {
          this.logger.warn(
            `Recompute completed but no posts cached for window ${window}`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Failed to recompute popular posts for window ${window}:`,
          error,
        );
      }
    }

    if (popularRanks.size === 0) {
      return [];
    }

    const allPopularIds = Array.from(popularRanks.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);

    const postIds: string[] = [];
    const pluginContentIds: string[] = [];
    for (const id of allPopularIds) {
      if (id.includes(':')) {
        pluginContentIds.push(id);
      } else {
        postIds.push(id);
      }
    }

    const CHUNK_SIZE = 1000;
    const existingIdsSet = new Set<string>();

    for (let i = 0; i < postIds.length; i += CHUNK_SIZE) {
      const chunk = postIds.slice(i, i + CHUNK_SIZE);
      const existingPosts = await this.postRepository.findBy({
        id: In(chunk),
        is_hidden: false,
        post_id: null,
      });
      existingPosts.forEach((p) => existingIdsSet.add(p.id));
    }

    for (const id of pluginContentIds) {
      const [type] = id.split(':');
      const hasContributor = this.rankingContributors.some(
        (c) => c.name === type,
      );
      if (hasContributor) {
        existingIdsSet.add(id);
      }
    }

    return allPopularIds.filter((id) => existingIdsSet.has(id));
  }

  async getPopularPosts(
    window: PopularWindow,
    limit = 50,
    offset = 0,
    maxCandidates?: number,
  ): Promise<(Post | PopularRankingContentItem)[]> {
    const verifiedIds = await this.getVerifiedPopularIds(window, maxCandidates);

    if (verifiedIds.length === 0) {
      return [];
    }

    const paginatedIds = verifiedIds.slice(offset, offset + limit);

    if (paginatedIds.length === 0) {
      return [];
    }

    const postIds: string[] = [];
    const pluginContentIds: string[] = [];
    for (const id of paginatedIds) {
      if (id.includes(':')) {
        pluginContentIds.push(id);
      } else {
        postIds.push(id);
      }
    }

    const posts =
      postIds.length > 0
        ? await this.postRepository.findBy({
            id: In(postIds),
            is_hidden: false,
            post_id: null,
          })
        : [];

    const pluginItems: PopularRankingContentItem[] = [];
    if (pluginContentIds.length > 0) {
      const itemsByType = new Map<string, string[]>();
      for (const id of pluginContentIds) {
        const [type] = id.split(':');
        if (!itemsByType.has(type)) {
          itemsByType.set(type, []);
        }
        itemsByType.get(type)!.push(id);
      }

      for (const contributor of this.rankingContributors) {
        const typeIds = itemsByType.get(contributor.name);
        if (typeIds && typeIds.length > 0) {
          try {
            const allItems = await contributor.getRankingCandidates(
              window,
              window === 'all'
                ? null
                : new Date(
                    Date.now() - this.getWindowHours(window) * 60 * 60 * 1000,
                  ),
              10000,
            );
            const requestedItems = allItems.filter((item) =>
              typeIds.includes(item.id),
            );
            pluginItems.push(...requestedItems);
          } catch (error) {
            this.logger.error(
              `Failed to fetch plugin content from ${contributor.name}:`,
              error,
            );
          }
        }
      }
    }

    const postsMap = new Map(posts.map((p) => [p.id, p]));
    const pluginItemsMap = new Map(pluginItems.map((item) => [item.id, item]));

    const result: (Post | PopularRankingContentItem)[] = [];
    for (const id of paginatedIds) {
      const post = postsMap.get(id);
      if (post) {
        result.push(post);
      } else {
        const item = pluginItemsMap.get(id);
        if (item) {
          result.push(item);
        }
      }
    }

    return result;
  }

  async getTotalCached(window: PopularWindow): Promise<number | undefined> {
    const key = this.getRedisKey(window);
    try {
      return await this.redis.zcard(key);
    } catch {
      return undefined;
    }
  }

  async getTotalPostsCount(window: PopularWindow): Promise<number> {
    try {
      const verifiedIds = await this.getVerifiedPopularIds(window);
      return verifiedIds.length;
    } catch (error) {
      this.logger.error(
        `Error in getTotalPostsCount for window ${window}:`,
        error,
      );
      return 0;
    }
  }

  async recompute(window: PopularWindow, maxCandidates = 10000): Promise<void> {
    const key = this.getRedisKey(window);
    const hours = this.getWindowHours(window);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    this.logger.log(
      `Starting recompute for window ${window} with maxCandidates ${maxCandidates}, key=${key}`,
    );

    try {
      await this.redis.ping();
    } catch (error) {
      this.logger.error(`Redis connection error:`, error);
      throw error;
    }

    const candidates = await this.postRepository
      .createQueryBuilder('post')
      .leftJoinAndSelect('post.topics', 'topic')
      .where('post.is_hidden = false')
      .andWhere('post.post_id IS NULL')
      .andWhere(window === 'all' ? '1=1' : 'post.created_at >= :since', {
        since,
      })
      .orderBy('post.created_at', 'DESC')
      .limit(maxCandidates)
      .getMany();

    this.logger.log(
      `Found ${candidates.length} candidate posts for window ${window}`,
    );

    const pluginContentItems: PopularRankingContentItem[] = [];
    const pluginLimit = Math.floor(
      maxCandidates / Math.max(1, this.rankingContributors.length + 1),
    );
    for (const contributor of this.rankingContributors) {
      try {
        const items = await contributor.getRankingCandidates(
          window,
          window === 'all' ? null : since,
          pluginLimit,
        );
        pluginContentItems.push(...items);
        this.logger.log(
          `Plugin ${contributor.name} contributed ${items.length} items for window ${window}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to fetch content from plugin ${contributor.name}:`,
          error,
        );
      }
    }
    this.logger.log(
      `Found ${pluginContentItems.length} plugin content items for window ${window}`,
    );

    if (candidates.length === 0 && pluginContentItems.length === 0) {
      await this.redis.del(key);
      this.logger.warn(
        `No candidates found for window ${window}, deleted Redis key`,
      );
      return;
    }

    if (candidates.length > 0) {
      this.logger.log(
        `First 5 candidate IDs: ${candidates
          .slice(0, 5)
          .map((c) => c.id)
          .join(', ')}`,
      );
    }

    // Preload tips per post
    const ids = candidates.map((c) => c.id);
    const tipsRaw = await this.tipRepository
      .createQueryBuilder('tip')
      .select('tip.post_id', 'post_id')
      .innerJoin(Post, 'post', 'post.id = tip.post_id')
      .addSelect('COALESCE(SUM(CAST(tip.amount AS numeric)), 0)', 'amount_sum')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COUNT(DISTINCT tip.sender_address)', 'unique_tippers')
      .where('tip.post_id IN (:...ids)', { ids })
      .andWhere('tip.sender_address != post.sender_address')
      .groupBy('tip.post_id')
      .getRawMany<{
        post_id: string;
        amount_sum: string;
        count: string;
        unique_tippers: string;
      }>();
    const tipsByPost = new Map(tipsRaw.map((t) => [t.post_id, t] as const));

    // Trending tags map (tag -> score)
    let trending = [] as TrendingTag[];
    try {
      trending = await this.trendingTagRepository.find();
    } catch {
      trending = [] as TrendingTag[];
    }
    const trendingByTag = new Map(
      trending.map((t) => [t.tag.toLowerCase(), t.score] as const),
    );

    // Preload reads over window per post
    const fromDate = new Date(Date.now() - hours * 3600 * 1000);
    const fromDateOnly = `${fromDate.getUTCFullYear()}-${String(
      fromDate.getUTCMonth() + 1,
    ).padStart(2, '0')}-${String(fromDate.getUTCDate()).padStart(2, '0')}`;
    const readsQB = this.postReadsRepository
      .createQueryBuilder('r')
      .select('r.post_id', 'post_id')
      .addSelect('COALESCE(SUM(r.reads), 0)', 'reads')
      .where('r.post_id IN (:...ids)', { ids });
    if (window !== 'all') {
      readsQB.andWhere('r.date >= :from', { from: fromDateOnly });
    }
    const readsRows = await readsQB
      .groupBy('r.post_id')
      .getRawMany<{ post_id: string; reads: string }>();
    const readsByPost = new Map(
      readsRows.map((r) => [r.post_id, parseInt(r.reads || '0', 10)] as const),
    );

    // Score posts
    const scoredPosts: PopularScoreItem[] = candidates.map((post) => {
      const tipsAgg = tipsByPost.get(post.id);
      return {
        postId: post.id,
        score: this.computeScore(trendingByTag, {
          content: post.content,
          comments: post.total_comments || 0,
          tipsAmountAE: tipsAgg
            ? parseFloat(tipsAgg.amount_sum || '0')
            : 0,
          tipsCount: tipsAgg ? parseInt(tipsAgg.count || '0', 10) : 0,
          reads: readsByPost.get(post.id) || 0,
          topics: post.topics,
        }),
        type: 'post',
      };
    });

    // Score plugin content items
    const scoredPluginItems: PopularScoreItem[] = pluginContentItems.map(
      (item) => ({
        postId: item.id,
        score: this.computeScore(trendingByTag, {
          content: item.content,
          comments: item.total_comments || 0,
          tipsAmountAE: 0,
          tipsCount: 0,
          reads: 0,
          topics: item.topics,
        }),
        type: item.type,
        metadata: item.metadata,
      }),
    );

    const scored = [...scoredPosts, ...scoredPluginItems];

    this.logger.log(
      `Window ${window}: ${scored.length} posts scored, all eligible (no score floor)`,
    );

    if (scored.length > 0) {
      const topScores = scored
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((s) => `${s.postId}:${s.score.toFixed(4)}`)
        .join(', ');
      this.logger.log(`Top 5 scores: ${topScores}`);
    }

    // Cache in Redis ZSET
    try {
      await this.redis.del(key);

      if (scored.length === 0) {
        this.logger.warn(`No posts to cache for window ${window}`);
        return;
      }

      const pipeline = this.redis.pipeline();
      for (const item of scored) {
        pipeline.zadd(key, item.score.toString(), item.postId);
      }
      pipeline.expire(key, POPULAR_RANKING_CONFIG.REDIS_TTL_SECONDS);
      const results = await pipeline.exec();

      if (results === null) {
        const error = new Error(`Redis pipeline failed for window ${window}`);
        this.logger.error(error.message);
        throw error;
      }

      const errors = results
        .filter((result) => result[0] !== null)
        .map((result) => result[0]);
      if (errors.length > 0) {
        const error = new Error(
          `Redis pipeline errors for window ${window}: ${JSON.stringify(errors)}`,
        );
        this.logger.error(error.message);
        throw error;
      }

      this.logger.log(
        `Successfully cached ${scored.length} popular posts in Redis key ${key}`,
      );

      const verifyCount = await this.redis.zcard(key);
      if (verifyCount !== scored.length) {
        const error = new Error(
          `Redis key ${key} has ${verifyCount} items but expected ${scored.length}`,
        );
        this.logger.error(error.message);
        throw error;
      }
    } catch (error) {
      this.logger.error(
        `Failed to cache popular posts in Redis for window ${window}:`,
        error,
      );
      throw error;
    }
  }

  private async loadTrendingByTagMap(): Promise<Map<string, number>> {
    let trending: TrendingTag[] = [];
    try {
      trending = await this.trendingTagRepository.find();
    } catch {
      trending = [];
    }
    return new Map(trending.map((t) => [t.tag.toLowerCase(), t.score] as const));
  }

  private computeScore(
    trendingByTag: Map<string, number>,
    input: {
      content: string;
      comments: number;
      tipsAmountAE: number;
      tipsCount: number;
      reads: number;
      topics?: Array<{ name?: string }>;
    },
  ): number {
    const { comments, tipsAmountAE, tipsCount, reads } = input;

    let trendingBoost = 0;
    if (input.topics?.length) {
      let maxScore = 0;
      for (const topic of input.topics) {
        const s = trendingByTag.get((topic.name || '').toLowerCase());
        if (s && s > maxScore) {
          maxScore = s;
        }
      }
      trendingBoost = Math.min(
        1,
        maxScore / POPULAR_RANKING_CONFIG.TRENDING_MAX_SCORE,
      );
    }

    const contentQuality = this.computeContentQuality(input.content || '');
    const w = POPULAR_RANKING_CONFIG.WEIGHTS;

    return (
      w.comments * Math.log(1 + comments) +
      w.tipsAmountAE * Math.log(1 + tipsAmountAE) +
      w.tipsCount * Math.log(1 + tipsCount) +
      w.reads * Math.log(1 + reads) +
      w.trendingBoost * trendingBoost +
      w.contentQuality * contentQuality
    );
  }

  async explain(window: PopularWindow, limit = 20, offset = 0) {
    const key = this.getRedisKey(window);
    const ids = await this.redis.zrevrange(key, offset, offset + limit - 1);
    const posts = ids.length
      ? await this.postRepository.findBy({ id: In(ids) })
      : await this.postRepository
          .createQueryBuilder('post')
          .where('post.is_hidden = false')
          .andWhere('post.post_id IS NULL')
          .orderBy('post.created_at', 'DESC')
          .limit(limit)
          .getMany();
    return posts.map((p) => ({
      id: p.id,
      tx: p.tx_hash,
      author: p.sender_address,
    }));
  }

  private computeContentQuality(content: string): number {
    if (!content) return 0;
    const cfg = POPULAR_RANKING_CONFIG.CONTENT;
    const len = content.length;
    const lengthScore = Math.max(
      0,
      Math.min(1, (len - cfg.minLengthForNoPenalty) / cfg.maxReferenceLength),
    );
    let emojis = 0;
    try {
      const emojiRegex = /[\p{Emoji_Presentation}\p{Emoji}\u200d]+/u;
      emojis = (content.match(emojiRegex) || []).length;
    } catch {
      emojis = 0;
    }
    const emojiRatio = Math.min(1, emojis / Math.max(1, len));
    const alnumMatches = content.match(/[A-Za-z0-9]/g) || [];
    const alnumRatio = Math.min(1, alnumMatches.length / Math.max(1, len));

    let quality = 0.6 * lengthScore + 0.2 * alnumRatio + 0.2 * (1 - emojiRatio);

    if (
      len < cfg.shortLengthThreshold &&
      emojiRatio > cfg.highEmojiRatioThreshold
    ) {
      quality *= 0.25;
    }

    return Math.max(0, Math.min(1, quality));
  }
}
