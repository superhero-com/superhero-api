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

type PopularWindow = '24h' | '7d' | 'all';

interface PopularScoreItem {
  postId: string;
  score: number;
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

  async getPopularPosts(
    window: PopularWindow,
    limit = 50,
    offset = 0,
    maxCandidates?: number,
  ) {
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
    } catch {
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
      await this.recompute(window, maxCandidates ?? fallbackMax);
      try {
        const totalPopular = await this.redis.zcard(key);
        if (totalPopular > 0) {
          const cached = await this.redis.zrevrange(key, 0, totalPopular - 1, 'WITHSCORES');
          for (let i = 0; i < cached.length; i += 2) {
            popularRanks.set(cached[i], parseFloat(cached[i + 1]));
          }
        }
      } catch {
        // Continue with empty popular ranks
      }
    }

    // Fetch latest posts ordered by created_at DESC
    // We fetch a bit more than needed to account for reordering
    // This ensures we have enough posts after sorting
    const fetchLimit = limit + Math.min(popularRanks.size, limit);
    const posts = await this.postRepository
      .createQueryBuilder('post')
      .where('post.is_hidden = false')
      .andWhere('post.post_id IS NULL')
      .orderBy('post.created_at', 'DESC')
      .skip(offset)
      .limit(fetchLimit)
      .getMany();

    // Sort posts: popular posts first (by rank DESC), then others (by created_at DESC)
    const sortedPosts = posts.sort((a, b) => {
      const aRank = popularRanks.get(a.id);
      const bRank = popularRanks.get(b.id);
      
      // If both are popular, sort by rank (higher rank first)
      if (aRank !== undefined && bRank !== undefined) {
        return bRank - aRank;
      }
      
      // If only a is popular, it comes first
      if (aRank !== undefined) {
        return -1;
      }
      
      // If only b is popular, it comes first
      if (bRank !== undefined) {
        return 1;
      }
      
      // Neither is popular, sort by created_at DESC (newer first)
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    // Return only the requested limit
    return sortedPosts.slice(0, limit);
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
   * Get total count of all posts (not hidden, top-level)
   * This is used for pagination metadata
   * Since we're now showing latest posts with popular at top (not excluding),
   * we just need the total count of all posts
   */
  async getTotalPostsCount(window: PopularWindow): Promise<number> {
    return await this.postRepository
      .createQueryBuilder('post')
      .where('post.is_hidden = false')
      .andWhere('post.post_id IS NULL')
      .getCount();
  }

  async recompute(window: PopularWindow, maxCandidates = 10000): Promise<void> {
    const key = this.getRedisKey(window);
    const hours = this.getWindowHours(window);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    // Fetch candidate posts (top-level, not hidden) within window
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

    if (candidates.length === 0) {
      await this.redis.del(key);
      return;
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

    const scored: PopularScoreItem[] = await Promise.all(
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
        const interactionsPerHour = (comments + uniqueTippers) / ageHours;

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
        const readsPerHour = reads / ageHours;
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

        let gravity = 0.0;
        if (window === '7d') {
          gravity = POPULAR_RANKING_CONFIG.GRAVITY_7D;
        } else if (window === '24h') {
          gravity = POPULAR_RANKING_CONFIG.GRAVITY;
        }
        const score =
          numerator /
          Math.pow(ageHours + POPULAR_RANKING_CONFIG.T_BIAS, gravity);
        return { postId: post.id, score };
      }),
    );

    // Apply score floor (hide zero-signal posts)
    let scoreFloor: number = POPULAR_RANKING_CONFIG.SCORE_FLOOR_DEFAULT;
    if (window === '7d') {
      scoreFloor = POPULAR_RANKING_CONFIG.SCORE_FLOOR_7D;
    } else if (window === 'all') {
      scoreFloor = POPULAR_RANKING_CONFIG.SCORE_FLOOR_ALL;
    }
    const eligible = scored.filter((s) => s.score >= scoreFloor);

    // Cache in Redis ZSET
    const multi = this.redis.multi();
    multi.del(key);
    for (const item of eligible) {
      multi.zadd(key, item.score.toString(), item.postId);
    }
    multi.expire(key, POPULAR_RANKING_CONFIG.REDIS_TTL_SECONDS);
    await multi.exec();
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
