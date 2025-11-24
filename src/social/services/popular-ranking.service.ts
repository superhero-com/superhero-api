import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Post } from '../entities/post.entity';
import { Tip } from '@/tipping/entities/tip.entity';
import { TrendingTag } from '@/trending-tags/entities/trending-tags.entity';
import { POPULAR_RANKING_CONFIG } from '@/configs/constants';
import Redis from 'ioredis';
import { REDIS_CONFIG } from '@/configs/redis';
import { Account } from '@/account/entities/account.entity';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { Token } from '@/tokens/entities/token.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { Invitation } from '@/affiliation/entities/invitation.entity';
import { PostReadsDaily } from '../entities/post-reads.entity';
import { PopularRankingContributor, PopularRankingContentItem } from '@/plugins/popular-ranking.interface';
import { Inject, Optional } from '@nestjs/common';
import { POPULAR_RANKING_CONTRIBUTOR } from '@/plugins/plugin.tokens';

export type PopularWindow = '24h' | '7d' | 'all';

interface PopularScoreItem {
  postId: string;
  score: number;
  type?: string; // 'post' or plugin content type (e.g., 'poll')
  metadata?: Record<string, any>; // Store plugin-specific metadata
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
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    @InjectRepository(TokenHolder)
    private readonly tokenHolderRepository: Repository<TokenHolder>,
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    private readonly aeSdkService: AeSdkService,
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
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
    return Number.MAX_SAFE_INTEGER; // all-time
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
   * This shared method ensures consistency between getPopularPosts and getTotalPostsCount
   */
  private async getVerifiedPopularIds(window: PopularWindow, maxCandidates?: number): Promise<string[]> {
    const key = this.getRedisKey(window);

    // Get popular post ranks from Redis (ID -> rank/score)
    let popularRanks = new Map<string, number>();
    try {
      const totalPopular = await this.redis.zcard(key);
      if (totalPopular > 0) {
        // Fetch all popular IDs with their scores
        const cached = await this.redis.zrevrange(key, 0, totalPopular - 1, 'WITHSCORES');
        for (let i = 0; i < cached.length; i += 2) {
          popularRanks.set(cached[i], parseFloat(cached[i + 1]));
        }
      }
    } catch (error) {
      this.logger.error(`Error loading from Redis:`, error);
      popularRanks = new Map();
    }

    // If no popular posts cached, try to compute them
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
          const cached = await this.redis.zrevrange(key, 0, totalPopular - 1, 'WITHSCORES');
          for (let i = 0; i < cached.length; i += 2) {
            popularRanks.set(cached[i], parseFloat(cached[i + 1]));
          }
          this.logger.log(`Recomputed popular posts for window ${window}: ${totalPopular} posts cached`);
        } else {
          this.logger.warn(`Recompute completed but no posts cached for window ${window}`);
        }
      } catch (error) {
        this.logger.error(`Failed to recompute popular posts for window ${window}:`, error);
        // Continue with empty popular ranks
      }
    }

    if (popularRanks.size === 0) {
      return [];
    }

    // Get popular post IDs sorted by score DESC
    const allPopularIds = Array.from(popularRanks.entries())
      .sort((a, b) => b[1] - a[1]) // Sort by score DESC
      .map(([id]) => id);

    // Separate post IDs from plugin content IDs
    const postIds: string[] = [];
    const pluginContentIds: string[] = [];
    for (const id of allPopularIds) {
      if (id.includes(':')) {
        // Plugin content IDs have format "type:id"
        pluginContentIds.push(id);
      } else {
        postIds.push(id);
      }
    }

    // Verify which post IDs exist in DB
    const CHUNK_SIZE = 1000;
    const existingIdsSet = new Set<string>();

    // Verify posts
    for (let i = 0; i < postIds.length; i += CHUNK_SIZE) {
      const chunk = postIds.slice(i, i + CHUNK_SIZE);
      const existingPosts = await this.postRepository.findBy({
        id: In(chunk),
        is_hidden: false,
        post_id: null,
      });
      existingPosts.forEach(p => existingIdsSet.add(p.id));
    }

    // Verify plugin content IDs by checking with contributors
    // For now, we'll trust plugin IDs from Redis (they should be valid)
    // In the future, we could add validation here
    for (const id of pluginContentIds) {
      // Check if any contributor can provide this ID
      const [type] = id.split(':');
      const hasContributor = this.rankingContributors.some(c => c.name === type);
      if (hasContributor) {
        existingIdsSet.add(id);
      }
    }

    // Filter allPopularIds to only include verified IDs, preserving the score DESC order
    const verifiedIds = allPopularIds.filter(id => existingIdsSet.has(id));

    return verifiedIds;
  }

  async getPopularPosts(
    window: PopularWindow,
    limit = 50,
    offset = 0,
    maxCandidates?: number,
  ): Promise<(Post | PopularRankingContentItem)[]> {
    // Get verified popular IDs (ensures consistency with getTotalPostsCount)
    const verifiedIds = await this.getVerifiedPopularIds(window, maxCandidates);
    
    if (verifiedIds.length === 0) {
      return [];
    }

    // Paginate the verified IDs
    const paginatedIds = verifiedIds.slice(offset, offset + limit);
    
    if (paginatedIds.length === 0) {
      return [];
    }

    // Separate post IDs from plugin content IDs
    const postIds: string[] = [];
    const pluginContentIds: string[] = [];
    for (const id of paginatedIds) {
      if (id.includes(':')) {
        // Plugin content IDs have format "type:id"
        pluginContentIds.push(id);
      } else {
        postIds.push(id);
      }
    }

    // Fetch posts
    const posts = postIds.length > 0
      ? await this.postRepository.findBy({
          id: In(postIds),
          is_hidden: false,
          post_id: null,
        })
      : [];

    // Fetch plugin content items
    const pluginItems: PopularRankingContentItem[] = [];
    if (pluginContentIds.length > 0) {
      // Get the content type from the ID prefix (e.g., "poll:123" -> "poll")
      const itemsByType = new Map<string, string[]>();
      for (const id of pluginContentIds) {
        const [type] = id.split(':');
        if (!itemsByType.has(type)) {
          itemsByType.set(type, []);
        }
        itemsByType.get(type)!.push(id);
      }

      // Fetch from each contributor
      for (const contributor of this.rankingContributors) {
        const typeIds = itemsByType.get(contributor.name);
        if (typeIds && typeIds.length > 0) {
          try {
            // Fetch all candidates and filter to requested IDs
            const allItems = await contributor.getRankingCandidates(
              window,
              window === 'all' ? null : new Date(Date.now() - this.getWindowHours(window) * 60 * 60 * 1000),
              10000, // Large limit to get all items
            );
            const requestedItems = allItems.filter(item =>
              typeIds.includes(item.id)
            );
            pluginItems.push(...requestedItems);
          } catch (error) {
            this.logger.error(`Failed to fetch plugin content from ${contributor.name}:`, error);
          }
        }
      }
    }

    // Merge posts and plugin items, preserving order from paginatedIds
    const idOrder = new Map(paginatedIds.map((id, index) => [id, index]));
    const postsMap = new Map(posts.map(p => [p.id, p]));
    const pluginItemsMap = new Map(pluginItems.map(item => [item.id, item]));

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

  // Public metadata helper to keep encapsulation
  async getTotalCached(window: PopularWindow): Promise<number | undefined> {
    const key = this.getRedisKey(window);
    try {
      return await this.redis.zcard(key);
    } catch {
      return undefined;
    }
  }

  /**
   * Get total count of popular posts for a given window
   * Uses the exact same verification logic as getPopularPosts to ensure consistency
   * This ensures pagination metadata matches actual returned posts even if posts are deleted/hidden
   */
  async getTotalPostsCount(window: PopularWindow): Promise<number> {
    try {
      // Use the same shared method as getPopularPosts to get verified IDs
      // This ensures both methods use the exact same verification logic at the same point in time
      const verifiedIds = await this.getVerifiedPopularIds(window);
      return verifiedIds.length;
    } catch (error) {
      this.logger.error(`Error in getTotalPostsCount for window ${window}:`, error);
      return 0;
    }
  }


  async recompute(window: PopularWindow, maxCandidates = 10000): Promise<void> {
    const key = this.getRedisKey(window);
    const hours = this.getWindowHours(window);
    // For 'all' window, don't calculate since date (would be invalid with Number.MAX_SAFE_INTEGER)
    const since = window === 'all' ? null : new Date(Date.now() - hours * 60 * 60 * 1000);

    this.logger.log(`Starting recompute for window ${window} with maxCandidates ${maxCandidates}, key=${key}`);
    
    // Verify Redis connection
    try {
      await this.redis.ping();
    } catch (error) {
      this.logger.error(`Redis connection error:`, error);
      throw error;
    }

    // Fetch candidate posts (top-level, not hidden) within window
    const queryBuilder = this.postRepository
      .createQueryBuilder('post')
      .leftJoinAndSelect('post.topics', 'topic')
      .where('post.is_hidden = false')
      .andWhere('post.post_id IS NULL');
    
    if (window !== 'all' && since) {
      queryBuilder.andWhere('post.created_at >= :since', { since });
    }
    
    // For 'all' window, order by total engagement signals to get truly popular posts
    // For time-limited windows, order by recency to get recent popular posts
    if (window === 'all') {
      // Order by total comments to prioritize highly engaged posts
      // No secondary sort by recency - we want all-time great posts regardless of age
      queryBuilder.orderBy('COALESCE(post.total_comments, 0)', 'DESC');
    } else {
      queryBuilder.orderBy('post.created_at', 'DESC');
    }
    
    const candidates = await queryBuilder
      .limit(maxCandidates)
      .getMany();

    this.logger.log(`Found ${candidates.length} candidate posts for window ${window}`);

    // Fetch plugin content items
    const pluginContentItems: PopularRankingContentItem[] = [];
    const pluginLimit = Math.floor(maxCandidates / Math.max(1, this.rankingContributors.length + 1));
    for (const contributor of this.rankingContributors) {
      try {
        const items = await contributor.getRankingCandidates(
          window,
          window === 'all' ? null : since,
          pluginLimit,
        );
        pluginContentItems.push(...items);
        this.logger.log(`Plugin ${contributor.name} contributed ${items.length} items for window ${window}`);
      } catch (error) {
        this.logger.error(`Failed to fetch content from plugin ${contributor.name}:`, error);
      }
    }
    this.logger.log(`Found ${pluginContentItems.length} plugin content items for window ${window}`);

    if (candidates.length === 0 && pluginContentItems.length === 0) {
      await this.redis.del(key);
      this.logger.warn(`No candidates found for window ${window}, deleted Redis key`);
      return;
    }

    // Log first few candidate IDs for debugging
    if (candidates.length > 0) {
      this.logger.log(`First 5 candidate IDs: ${candidates.slice(0, 5).map(c => c.id).join(', ')}`);
    }

    // Preload tips per post (sum and count and unique tippers)
    const ids = candidates.map((c) => c.id);
    const tipsRaw = await this.tipRepository
      .createQueryBuilder('tip')
      .select('tip.post_id', 'post_id')
      .addSelect('COALESCE(SUM(CAST(tip.amount AS numeric)), 0)', 'amount_sum')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COUNT(DISTINCT tip.sender_address)', 'unique_tippers')
      .where('tip.post_id IN (:...ids)', { ids })
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

    // Load authors accounts for signals
    const authors = Array.from(
      new Set(candidates.map((p) => p.sender_address)),
    );
    const accounts = await this.accountRepository.findBy({
      address: In(authors),
    });
    const accountByAddress = new Map(
      accounts.map((a) => [a.address, a] as const),
    );

    // Preload owned tokens portfolio value per author (without trending weight)
    const aeValueField =
      "COALESCE((token.price_data->>'ae')::numeric, token.price::numeric, 0)";
    const usdValueField = "COALESCE((token.price_data->>'usd')::numeric, 0)";
    const valueField =
      POPULAR_RANKING_CONFIG.OWNED_TRENDS_VALUE_CURRENCY === 'usd'
        ? usdValueField
        : aeValueField;

    let tokenHoldings: { address: string; owned_value: string }[] = [];
    try {
      tokenHoldings = await this.tokenHolderRepository
        .createQueryBuilder('holder')
        .leftJoin(Token, 'token', 'token.address = holder.aex9_address')
        .select('holder.address', 'address')
        .addSelect(
          `SUM((CAST(holder.balance AS numeric) / NULLIF(POWER(10, token.decimals::int), 0)) * ${valueField})`,
          'owned_value',
        )
        .where('holder.address IN (:...authors)', { authors })
        .groupBy('holder.address')
        .getRawMany<{ address: string; owned_value: string }>();
    } catch {
      tokenHoldings = [];
    }
    const ownedValueByAddress = new Map(
      tokenHoldings.map(
        (r) => [r.address, parseFloat(r.owned_value || '0')] as const,
      ),
    );

    // Preload invites sent per author from invitations
    let invitesRows: { sender: string; sent: string }[] = [];
    try {
      invitesRows = await this.invitationRepository
        .createQueryBuilder('inv')
        .select('inv.sender_address', 'sender')
        .addSelect('COUNT(*)', 'sent')
        .where('inv.sender_address IN (:...authors)', { authors })
        .groupBy('inv.sender_address')
        .getRawMany<{ sender: string; sent: string }>();
    } catch {
      invitesRows = [];
    }
    const invitesByAddress = new Map(
      invitesRows.map((r) => [r.sender, parseInt(r.sent || '0', 10)] as const),
    );

    // Preload reads over window per post
    // For 'all' window, get all reads (no date filter)
    // For time-limited windows, filter reads by date
    const readsQB = this.postReadsRepository
      .createQueryBuilder('r')
      .select('r.post_id', 'post_id')
      .addSelect('COALESCE(SUM(r.reads), 0)', 'reads')
      .where('r.post_id IN (:...ids)', { ids });
    if (window !== 'all') {
      const fromDate = new Date(Date.now() - hours * 3600 * 1000);
      const fromDateOnly = `${fromDate.getUTCFullYear()}-${String(
        fromDate.getUTCMonth() + 1,
      ).padStart(2, '0')}-${String(fromDate.getUTCDate()).padStart(2, '0')}`;
      readsQB.andWhere('r.date >= :from', { from: fromDateOnly });
    }
    const readsRows = await readsQB
      .groupBy('r.post_id')
      .getRawMany<{ post_id: string; reads: string }>();
    const readsByPost = new Map(
      readsRows.map((r) => [r.post_id, parseInt(r.reads || '0', 10)] as const),
    );

    // Score posts
    const scoredPosts: PopularScoreItem[] = await Promise.all(
      candidates.map(async (post) => {
        const comments = post.total_comments || 0;
        const tipsAgg = tipsByPost.get(post.id);
        const tipsAmountAE = tipsAgg
          ? parseFloat(tipsAgg.amount_sum || '0')
          : 0;
        const tipsCount = tipsAgg ? parseInt(tipsAgg.count || '0', 10) : 0;
        const uniqueTippers = tipsAgg
          ? parseInt(tipsAgg.unique_tippers || '0', 10)
          : 0;

        const ageHours = Math.max(
          1,
          (Date.now() - new Date(post.created_at).getTime()) / 3_600_000,
        );
        // For 'all' window, use total interactions (not per-hour) to avoid favoring newer posts
        // For time-limited windows, use per-hour rate to favor recent engagement
        const interactionsPerHour = window === 'all' 
          ? (comments + uniqueTippers) // Total interactions for all-time
          : (comments + uniqueTippers) / ageHours; // Per-hour rate for time-limited windows

        // trending boost (max topic score)
        let trendingBoost = 0;
        if (post.topics?.length) {
          let maxScore = 0;
          for (const topic of post.topics) {
            const s = trendingByTag.get((topic.name || '').toLowerCase());
            if (s && s > maxScore) maxScore = s;
          }
          trendingBoost = Math.min(
            1,
            maxScore / POPULAR_RANKING_CONFIG.TRENDING_MAX_SCORE,
          );
        }

        const contentQuality = this.computeContentQuality(post.content || '');

        // account signals
        const account = accountByAddress.get(post.sender_address);
        let accountBalanceFactor = 0;
        let accountAgeFactor = 0;
        let invitesFactor = 0;
        if (account) {
          // AE balance via Ae SDK with short Redis cache
          const cacheKey = `accbal:${account.address}`;
          let aeBalance = 0;
          const cached = await this.redis.get(cacheKey);
          if (cached) {
            aeBalance = parseFloat(cached) || 0;
          } else {
            try {
              const raw = await this.aeSdkService.sdk.getBalance(
                account.address as `ak_${string}`,
              );
              aeBalance = Number(raw) / 1e18; // wei -> AE
              await this.redis.setex(
                cacheKey,
                POPULAR_RANKING_CONFIG.BALANCE_CACHE_TTL_SECONDS,
                aeBalance.toString(),
              );
            } catch {
              aeBalance = 0;
            }
          }
          accountBalanceFactor = Math.max(
            0,
            Math.min(
              1,
              aeBalance / POPULAR_RANKING_CONFIG.BALANCE_NORMALIZER_AE,
            ),
          );

          const days =
            (Date.now() - new Date(account.created_at).getTime()) / 86_400_000;
          accountAgeFactor = Math.max(
            0,
            Math.min(1, 1 / (1 + Math.exp(-(days - 14) / 14))),
          );

          const sentInvites =
            invitesByAddress.get(account.address) ??
            account.total_invitation_count ??
            0;
          invitesFactor = Math.min(
            1,
            Math.log(1 + sentInvites) / Math.log(1 + 100),
          );
        }

        const w = POPULAR_RANKING_CONFIG.WEIGHTS;
        const reads = readsByPost.get(post.id) || 0;
        // For 'all' window, use total reads (not per-hour) to avoid favoring newer posts
        // For time-limited windows, use per-hour rate to favor recent engagement
        const readsPerHour = window === 'all' 
          ? reads // Total reads for all-time
          : reads / ageHours; // Per-hour rate for time-limited windows
        // owned trends factor: normalize value portfolio into [0..1]
        const ownedRaw = ownedValueByAddress.get(post.sender_address) || 0;
        const normalizer =
          POPULAR_RANKING_CONFIG.OWNED_TRENDS_VALUE_CURRENCY === 'usd'
            ? POPULAR_RANKING_CONFIG.OWNED_TRENDS_VALUE_NORMALIZER_USD
            : POPULAR_RANKING_CONFIG.OWNED_TRENDS_VALUE_NORMALIZER_AE;
        const ownedNorm = Math.max(
          0,
          Math.min(1, ownedRaw / Math.max(1, normalizer)),
        );
        const numerator =
          w.comments * Math.log(1 + comments) +
          w.tipsAmountAE * Math.log(1 + tipsAmountAE) +
          w.tipsCount * Math.log(1 + tipsCount) +
          w.interactionsPerHour * Math.log(1 + interactionsPerHour) +
          w.reads * Math.log(1 + readsPerHour) +
          w.trendingBoost * trendingBoost +
          w.contentQuality * contentQuality +
          w.accountBalance * accountBalanceFactor +
          w.accountAge * accountAgeFactor +
          w.invites * invitesFactor +
          w.ownedTrends * ownedNorm;

        // Apply gravity based on window
        // For "all" window, no gravity (0.0) means all posts compete equally regardless of age
        // This allows all-time great posts to shine, not just recent popular ones
        let gravity = 0.0;
        if (window === '7d') {
          gravity = POPULAR_RANKING_CONFIG.GRAVITY_7D;
        } else if (window === '24h') {
          gravity = POPULAR_RANKING_CONFIG.GRAVITY;
        }
        // window === 'all' uses gravity = 0.0 (no time decay)
        const score =
          numerator /
          Math.pow(ageHours + POPULAR_RANKING_CONFIG.T_BIAS, gravity);
        return { postId: post.id, score, type: 'post' };
      }),
    );

    // Score plugin content items
    const scoredPluginItems: PopularScoreItem[] = await Promise.all(
      pluginContentItems.map(async (item) => {
        // Use votes_count as comments equivalent for polls
        const comments = item.total_comments || 0;
        // Plugin items don't have tips (for now)
        const tipsAmountAE = 0;
        const tipsCount = 0;
        const uniqueTippers = 0;

        const ageHours = Math.max(
          1,
          (Date.now() - new Date(item.created_at).getTime()) / 3_600_000,
        );
        // For 'all' window, use total interactions (not per-hour) to avoid favoring newer items
        // For time-limited windows, use per-hour rate to favor recent engagement
        const interactionsPerHour = window === 'all' 
          ? (comments + uniqueTippers) // Total interactions for all-time
          : (comments + uniqueTippers) / ageHours; // Per-hour rate for time-limited windows

        // Trending boost (max topic score)
        let trendingBoost = 0;
        if (item.topics?.length) {
          let maxScore = 0;
          for (const topic of item.topics) {
            const s = trendingByTag.get((topic.name || '').toLowerCase());
            if (s && s > maxScore) maxScore = s;
          }
          trendingBoost = Math.min(
            1,
            maxScore / POPULAR_RANKING_CONFIG.TRENDING_MAX_SCORE,
          );
        }

        const contentQuality = this.computeContentQuality(item.content || '');

        // Account signals
        const account = accountByAddress.get(item.sender_address);
        let accountBalanceFactor = 0;
        let accountAgeFactor = 0;
        let invitesFactor = 0;
        if (account) {
          const cacheKey = `accbal:${account.address}`;
          let aeBalance = 0;
          const cached = await this.redis.get(cacheKey);
          if (cached) {
            aeBalance = parseFloat(cached) || 0;
          } else {
            try {
              const raw = await this.aeSdkService.sdk.getBalance(
                account.address as `ak_${string}`,
              );
              aeBalance = Number(raw) / 1e18;
              await this.redis.setex(
                cacheKey,
                POPULAR_RANKING_CONFIG.BALANCE_CACHE_TTL_SECONDS,
                aeBalance.toString(),
              );
            } catch {
              aeBalance = 0;
            }
          }
          accountBalanceFactor = Math.max(
            0,
            Math.min(
              1,
              aeBalance / POPULAR_RANKING_CONFIG.BALANCE_NORMALIZER_AE,
            ),
          );

          const days =
            (Date.now() - new Date(account.created_at).getTime()) / 86_400_000;
          accountAgeFactor = Math.max(
            0,
            Math.min(1, 1 / (1 + Math.exp(-(days - 14) / 14))),
          );

          const sentInvites =
            invitesByAddress.get(account.address) ??
            account.total_invitation_count ??
            0;
          invitesFactor = Math.min(
            1,
            Math.log(1 + sentInvites) / Math.log(1 + 100),
          );
        }

        const w = POPULAR_RANKING_CONFIG.WEIGHTS;
        const reads = 0; // Plugin items don't have reads tracking (for now)
        // For 'all' window, use total reads (not per-hour) to avoid favoring newer items
        // For time-limited windows, use per-hour rate to favor recent engagement
        const readsPerHour = window === 'all' 
          ? reads // Total reads for all-time
          : reads / ageHours; // Per-hour rate for time-limited windows
        const ownedRaw = ownedValueByAddress.get(item.sender_address) || 0;
        const normalizer =
          POPULAR_RANKING_CONFIG.OWNED_TRENDS_VALUE_CURRENCY === 'usd'
            ? POPULAR_RANKING_CONFIG.OWNED_TRENDS_VALUE_NORMALIZER_USD
            : POPULAR_RANKING_CONFIG.OWNED_TRENDS_VALUE_NORMALIZER_AE;
        const ownedNorm = Math.max(
          0,
          Math.min(1, ownedRaw / Math.max(1, normalizer)),
        );
        const numerator =
          w.comments * Math.log(1 + comments) +
          w.tipsAmountAE * Math.log(1 + tipsAmountAE) +
          w.tipsCount * Math.log(1 + tipsCount) +
          w.interactionsPerHour * Math.log(1 + interactionsPerHour) +
          w.reads * Math.log(1 + readsPerHour) +
          w.trendingBoost * trendingBoost +
          w.contentQuality * contentQuality +
          w.accountBalance * accountBalanceFactor +
          w.accountAge * accountAgeFactor +
          w.invites * invitesFactor +
          w.ownedTrends * ownedNorm;

        let gravity = 0.0;
        if (window === '7d') {
          gravity = POPULAR_RANKING_CONFIG.GRAVITY_7D;
        } else if (window === '24h') {
          gravity = POPULAR_RANKING_CONFIG.GRAVITY;
        }
        const score =
          numerator /
          Math.pow(ageHours + POPULAR_RANKING_CONFIG.T_BIAS, gravity);
        return {
          postId: item.id,
          score,
          type: item.type,
          metadata: item.metadata,
        };
      }),
    );

    // Merge all scored items
    const scored = [...scoredPosts, ...scoredPluginItems];

    // Sort by score DESC to ensure consistent ordering
    scored.sort((a, b) => b.score - a.score);

    // Apply score floor (hide zero-signal posts)
    let scoreFloor: number = POPULAR_RANKING_CONFIG.SCORE_FLOOR_DEFAULT;
    if (window === '7d') {
      scoreFloor = POPULAR_RANKING_CONFIG.SCORE_FLOOR_7D;
    } else if (window === 'all') {
      scoreFloor = POPULAR_RANKING_CONFIG.SCORE_FLOOR_ALL;
    }
    const eligible = scored.filter((s) => s.score >= scoreFloor);

    this.logger.log(`Window ${window}: ${scored.length} posts scored, ${eligible.length} eligible (scoreFloor: ${scoreFloor})`);
    
    // Log top scores for debugging
    if (scored.length > 0) {
      const topScores = scored
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(s => `${s.postId}:${s.score.toFixed(4)}`)
        .join(', ');
      this.logger.log(`Top 5 scores: ${topScores}`);
    }

    // Cache in Redis ZSET
    try {
      // Delete existing key first
      await this.redis.del(key);
      
      if (eligible.length === 0) {
        this.logger.warn(`No eligible posts to cache for window ${window} (all posts below score floor ${scoreFloor})`);
        return;
      }
      
      // Use pipeline instead of multi for better error handling
      const pipeline = this.redis.pipeline();
      for (const item of eligible) {
        pipeline.zadd(key, item.score.toString(), item.postId);
      }
      pipeline.expire(key, POPULAR_RANKING_CONFIG.REDIS_TTL_SECONDS);
      const results = await pipeline.exec();
      
      // Check for errors in results
      if (results === null) {
        const error = new Error(`Redis pipeline failed for window ${window}`);
        this.logger.error(error.message);
        throw error;
      }
      
      const errors = results.filter((result) => result[0] !== null).map((result) => result[0]);
      if (errors.length > 0) {
        const error = new Error(`Redis pipeline errors for window ${window}: ${JSON.stringify(errors)}`);
        this.logger.error(error.message);
        throw error;
      }
      
      this.logger.log(`Successfully cached ${eligible.length} popular posts in Redis key ${key}`);
      
      // Verify the cache was written
      const verifyCount = await this.redis.zcard(key);
      if (verifyCount !== eligible.length) {
        const error = new Error(`Redis key ${key} has ${verifyCount} items but expected ${eligible.length}`);
        this.logger.error(error.message);
        throw error;
      }
    } catch (error) {
      this.logger.error(`Failed to cache popular posts in Redis for window ${window}:`, error);
      throw error;
    }
  }

  // Debug helper: returns top-N with feature breakdowns without caching side-effects
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
      quality *= 0.25; // strong penalty for emoji-only very short posts
    }

    return Math.max(0, Math.min(1, quality));
  }
}
