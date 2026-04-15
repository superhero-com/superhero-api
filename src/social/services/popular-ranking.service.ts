import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Post } from '../entities/post.entity';
import { Tip } from '@/tipping/entities/tip.entity';
import { TrendingTag } from '@/trending-tags/entities/trending-tags.entity';
import {
  POPULAR_RANKING_CONFIG,
  type PopularRankingWeightScale,
} from '@/configs/constants';
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

type PopularCustomizableWeightKey =
  | 'comments'
  | 'tipsAmountAE'
  | 'tipsCount'
  | 'uniqueTippers'
  | 'trendingBoost'
  | 'contentQuality'
  | 'reads'
  | 'interactionsPerHour';

export type PopularRankingWeightOverrides = Partial<
  Record<PopularCustomizableWeightKey, PopularRankingWeightScale | undefined>
>;

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

type PopularRankingResolvedWeights = Mutable<
  typeof POPULAR_RANKING_CONFIG.WEIGHTS
> & {
  interactionsPerHour: number;
};

interface PopularScoreInput {
  content: string;
  comments: number;
  tipsAmountAE: number;
  tipsCount: number;
  uniqueTippers: number;
  reads: number;
  topics?: Array<{ name?: string }>;
  createdAt?: Date | string;
}

@Injectable()
export class PopularRankingService {
  private readonly logger = new Logger(PopularRankingService.name);
  private readonly redis = new Redis(REDIS_CONFIG);
  private readonly recomputeInFlight = new Map<PopularWindow, Promise<void>>();
  private trendingTagCache: {
    map: Map<string, number>;
    expiresAt: number;
  } | null = null;
  private static readonly TRENDING_CACHE_TTL_MS = 30_000;

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

  private getDefaultMaxCandidates(window: PopularWindow): number {
    return window === 'all'
      ? POPULAR_RANKING_CONFIG.MAX_CANDIDATES_ALL
      : window === '7d'
        ? POPULAR_RANKING_CONFIG.MAX_CANDIDATES_7D
        : POPULAR_RANKING_CONFIG.MAX_CANDIDATES_24H;
  }

  private hasWeightOverrides(
    overrides?: PopularRankingWeightOverrides,
  ): overrides is PopularRankingWeightOverrides {
    return !!overrides && Object.values(overrides).some((value) => !!value);
  }

  private resolveWeights(
    overrides?: PopularRankingWeightOverrides,
  ): PopularRankingResolvedWeights {
    const resolved: PopularRankingResolvedWeights = {
      ...POPULAR_RANKING_CONFIG.WEIGHTS,
      interactionsPerHour: 0,
    };

    if (!this.hasWeightOverrides(overrides)) {
      return resolved;
    }

    const multipliers = POPULAR_RANKING_CONFIG.CUSTOMIZATION.SCALE_MULTIPLIERS;
    for (const [key, value] of Object.entries(overrides)) {
      if (!value) {
        continue;
      }

      const multiplier = multipliers[value];
      if (key === 'interactionsPerHour') {
        resolved.interactionsPerHour =
          POPULAR_RANKING_CONFIG.CUSTOMIZATION.ADDITIONAL_SIGNAL_WEIGHTS
            .interactionsPerHour * multiplier;
      } else if (key in resolved) {
        (resolved as Record<string, number>)[key] *= multiplier;
      }
    }

    return resolved;
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
      await this.awaitOrTriggerRecompute(window, maxCandidates);

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
        this.logger.error(`Error loading from Redis after recompute:`, error);
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

  /**
   * Fallback when the ranked cache is empty (cold start / TTL expiry).
   * Returns the most recent top-level, visible posts so the feed is never blank.
   * Respects the time window so each window returns different results.
   */
  private async fetchRecentFallback(
    window: PopularWindow,
    limit: number,
    offset: number,
  ): Promise<Post[]> {
    const qb = this.postRepository
      .createQueryBuilder('post')
      .where('post.is_hidden = false')
      .andWhere('post.post_id IS NULL');

    if (window !== 'all') {
      const hours = this.getWindowHours(window);
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      qb.andWhere('post.created_at >= :since', { since });
    }

    return qb
      .orderBy('post.created_at', 'DESC')
      .offset(offset)
      .limit(limit)
      .getMany();
  }

  private async countRecentFallback(window: PopularWindow): Promise<number> {
    const qb = this.postRepository
      .createQueryBuilder('post')
      .where('post.is_hidden = false')
      .andWhere('post.post_id IS NULL');

    if (window !== 'all') {
      const hours = this.getWindowHours(window);
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      qb.andWhere('post.created_at >= :since', { since });
    }

    return qb.getCount();
  }

  /**
   * Await an existing in-flight recompute or start one.
   * Per-window mutex prevents stampede — concurrent callers share one promise.
   */
  private async awaitOrTriggerRecompute(
    window: PopularWindow,
    maxCandidates?: number,
  ): Promise<void> {
    const existing = this.recomputeInFlight.get(window);
    if (existing) {
      await existing;
      return;
    }

    const fallbackMax = this.getDefaultMaxCandidates(window);

    const task = this.recompute(window, maxCandidates ?? fallbackMax)
      .catch((error) =>
        this.logger.error(`Recompute failed for window ${window}:`, error),
      )
      .finally(() => this.recomputeInFlight.delete(window));

    this.recomputeInFlight.set(window, task);
    await task;
  }

  private async hydrateRankedItems(
    window: PopularWindow,
    ids: string[],
  ): Promise<(Post | PopularRankingContentItem)[]> {
    if (ids.length === 0) {
      return [];
    }

    const postIds: string[] = [];
    const pluginContentIds: string[] = [];
    for (const id of ids) {
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

      const since =
        window === 'all'
          ? null
          : new Date(Date.now() - this.getWindowHours(window) * 60 * 60 * 1000);

      for (const contributor of this.rankingContributors) {
        const typeIds = itemsByType.get(contributor.name);
        if (typeIds && typeIds.length > 0) {
          try {
            const allItems = await contributor.getRankingCandidates(
              window,
              since,
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
    for (const id of ids) {
      const post = postsMap.get(id);
      if (post) {
        result.push(post);
        continue;
      }

      const item = pluginItemsMap.get(id);
      if (item) {
        result.push(item);
      }
    }

    return result;
  }

  async getPopularPosts(
    window: PopularWindow,
    limit = 50,
    offset = 0,
    maxCandidates?: number,
  ): Promise<(Post | PopularRankingContentItem)[]> {
    const verifiedIds = await this.getVerifiedPopularIds(window, maxCandidates);

    if (verifiedIds.length === 0) {
      return this.fetchRecentFallback(window, limit, offset);
    }

    return this.hydrateRankedItems(
      window,
      verifiedIds.slice(offset, offset + limit),
    );
  }

  async getPopularPostsPage(
    window: PopularWindow,
    limit = 50,
    offset = 0,
    maxCandidates?: number,
    weightOverrides?: PopularRankingWeightOverrides,
  ): Promise<{
    items: (Post | PopularRankingContentItem)[];
    totalItems: number;
    scoredItems?: PopularScoreItem[];
  }> {
    if (!this.hasWeightOverrides(weightOverrides)) {
      const totalItems = await this.getTotalPostsCount(window);
      const items = await this.getPopularPosts(
        window,
        limit,
        offset,
        maxCandidates,
      );
      return { items, totalItems };
    }

    const scored = await this.buildScoredItems(
      window,
      maxCandidates ?? this.getDefaultMaxCandidates(window),
      weightOverrides,
    );
    const paginatedIds = scored
      .slice(offset, offset + limit)
      .map((item) => item.postId);

    return {
      items: await this.hydrateRankedItems(window, paginatedIds),
      totalItems: scored.length,
      scoredItems: scored,
    };
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
      if (verifiedIds.length > 0) {
        return verifiedIds.length;
      }
      return this.countRecentFallback(window);
    } catch (error) {
      this.logger.error(
        `Error in getTotalPostsCount for window ${window}:`,
        error,
      );
      return 0;
    }
  }

  private async buildScoredItems(
    window: PopularWindow,
    maxCandidates = 10000,
    weightOverrides?: PopularRankingWeightOverrides,
  ): Promise<PopularScoreItem[]> {
    const hours = this.getWindowHours(window);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

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

    if (candidates.length > 0) {
      this.logger.log(
        `First 5 candidate IDs: ${candidates
          .slice(0, 5)
          .map((c) => c.id)
          .join(', ')}`,
      );
    }

    const ids = candidates.map((c) => c.id);
    let tipsByPost = new Map<string, any>();
    let commentsByPost = new Map<string, number>();
    let readsByPost = new Map<string, number>();

    if (ids.length > 0) {
      const tipsRaw = await this.tipRepository
        .createQueryBuilder('tip')
        .select('tip.post_id', 'post_id')
        .innerJoin(Post, 'post', 'post.id = tip.post_id')
        .addSelect(
          'COALESCE(SUM(CAST(tip.amount AS numeric)), 0)',
          'amount_sum',
        )
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
      tipsByPost = new Map(tipsRaw.map((t) => [t.post_id, t] as const));

      const commentsRaw = await this.postRepository
        .createQueryBuilder('comment')
        .innerJoin(Post, 'parent', 'parent.id = comment.post_id')
        .select('comment.post_id', 'parent_id')
        .addSelect('COUNT(*)', 'count')
        .where('comment.post_id IN (:...ids)', { ids })
        .andWhere('comment.is_hidden = false')
        .andWhere('comment.sender_address != parent.sender_address')
        .groupBy('comment.post_id')
        .getRawMany<{ parent_id: string; count: string }>();
      commentsByPost = new Map(
        commentsRaw.map(
          (r) => [r.parent_id, parseInt(r.count || '0', 10)] as const,
        ),
      );

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
      readsByPost = new Map(
        readsRows.map(
          (r) => [r.post_id, parseInt(r.reads || '0', 10)] as const,
        ),
      );
    }

    const trendingByTag = await this.loadTrendingByTagMap();
    const resolvedWeights = this.resolveWeights(weightOverrides);

    const scoredPosts: PopularScoreItem[] = candidates.map((post) => {
      const tipsAgg = tipsByPost.get(post.id);
      return {
        postId: post.id,
        score: this.computeScore(
          trendingByTag,
          {
            content: post.content,
            comments: commentsByPost.get(post.id) || 0,
            tipsAmountAE: tipsAgg ? parseFloat(tipsAgg.amount_sum || '0') : 0,
            tipsCount: tipsAgg ? parseInt(tipsAgg.count || '0', 10) : 0,
            uniqueTippers: tipsAgg
              ? parseInt(tipsAgg.unique_tippers || '0', 10)
              : 0,
            reads: readsByPost.get(post.id) || 0,
            topics: post.topics,
            createdAt: post.created_at,
          },
          resolvedWeights,
          window,
        ),
        type: 'post',
      };
    });

    const scoredPluginItems: PopularScoreItem[] = pluginContentItems.map(
      (item) => ({
        postId: item.id,
        score: this.computeScore(
          trendingByTag,
          {
            content: item.content,
            comments: item.total_comments || 0,
            tipsAmountAE: 0,
            tipsCount: 0,
            uniqueTippers: 0,
            reads: 0,
            topics: item.topics,
            createdAt: item.created_at,
          },
          resolvedWeights,
          window,
        ),
        type: item.type,
        metadata: item.metadata,
      }),
    );

    return [...scoredPosts, ...scoredPluginItems].sort(
      (a, b) => b.score - a.score,
    );
  }

  async recompute(window: PopularWindow, maxCandidates = 10000): Promise<void> {
    const key = this.getRedisKey(window);

    this.logger.log(
      `Starting recompute for window ${window} with maxCandidates ${maxCandidates}, key=${key}`,
    );

    try {
      await this.redis.ping();
    } catch (error) {
      this.logger.error(`Redis connection error:`, error);
      throw error;
    }

    const scored = await this.buildScoredItems(window, maxCandidates);

    if (scored.length === 0) {
      await this.redis.del(key);
      this.logger.warn(
        `No candidates found for window ${window}, deleted Redis key`,
      );
      return;
    }

    this.logger.log(
      `Window ${window}: ${scored.length} posts scored, all eligible (no score floor)`,
    );

    const topScores = scored
      .slice(0, 5)
      .map((s) => `${s.postId}:${s.score.toFixed(4)}`)
      .join(', ');
    this.logger.log(`Top 5 scores: ${topScores}`);

    try {
      await this.redis.del(key);

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
    if (this.trendingTagCache && Date.now() < this.trendingTagCache.expiresAt) {
      return this.trendingTagCache.map;
    }

    let trending: TrendingTag[] = [];
    try {
      trending = await this.trendingTagRepository.find();
    } catch {
      trending = [];
    }
    const map = new Map(
      trending.map((t) => [t.tag.toLowerCase(), t.score] as const),
    );
    this.trendingTagCache = {
      map,
      expiresAt: Date.now() + PopularRankingService.TRENDING_CACHE_TTL_MS,
    };
    return map;
  }

  private computeInteractionsPerHour(
    input: PopularScoreInput,
    window: PopularWindow,
  ): number {
    const createdAt =
      input.createdAt instanceof Date
        ? input.createdAt
        : input.createdAt
          ? new Date(input.createdAt)
          : null;

    if (!createdAt || Number.isNaN(createdAt.getTime())) {
      return 0;
    }

    const ageHours = Math.max(
      1,
      (Date.now() - createdAt.getTime()) / (60 * 60 * 1000),
    );
    const effectiveHours =
      window === 'all'
        ? ageHours
        : Math.min(ageHours, this.getWindowHours(window));

    return (
      (input.comments + input.tipsCount + input.uniqueTippers) /
      Math.max(1, effectiveHours)
    );
  }

  private computeScore(
    trendingByTag: Map<string, number>,
    input: PopularScoreInput,
    weights: PopularRankingResolvedWeights,
    window: PopularWindow,
  ): number {
    const { comments, tipsAmountAE, tipsCount, uniqueTippers, reads } = input;

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
    const interactionsPerHour = this.computeInteractionsPerHour(input, window);

    return (
      weights.comments * Math.log(1 + comments) +
      weights.tipsAmountAE * Math.log(1 + tipsAmountAE) +
      weights.tipsCount * Math.log(1 + tipsCount) +
      weights.uniqueTippers * Math.log(1 + uniqueTippers) +
      weights.reads * Math.log(1 + reads) +
      weights.trendingBoost * trendingBoost +
      weights.contentQuality * contentQuality +
      weights.interactionsPerHour * Math.log(1 + interactionsPerHour)
    );
  }

  async explain(
    window: PopularWindow,
    limit = 20,
    offset = 0,
    weightOverrides?: PopularRankingWeightOverrides,
    precomputedScored?: PopularScoreItem[],
  ) {
    const personalized = this.hasWeightOverrides(weightOverrides);
    const appliedWeights = personalized
      ? this.resolveWeights(weightOverrides)
      : this.resolveWeights();

    let items: (Post | PopularRankingContentItem)[];

    if (personalized) {
      const scored =
        precomputedScored ??
        (await this.buildScoredItems(
          window,
          this.getDefaultMaxCandidates(window),
          weightOverrides,
        ));
      const ids = scored
        .slice(offset, offset + limit)
        .map((item) => item.postId);
      items = await this.hydrateRankedItems(window, ids);
    } else {
      const key = this.getRedisKey(window);
      const ids = await this.redis.zrevrange(key, offset, offset + limit - 1);
      items = ids.length
        ? await this.postRepository.findBy({ id: In(ids) })
        : await this.postRepository
            .createQueryBuilder('post')
            .where('post.is_hidden = false')
            .andWhere('post.post_id IS NULL')
            .orderBy('post.created_at', 'DESC')
            .limit(limit)
            .getMany();
    }

    return items.map((item) => ({
      id: item.id,
      tx: 'tx_hash' in item ? item.tx_hash : undefined,
      author: item.sender_address,
      personalized,
      appliedWeights,
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
