import { AeSdkService } from '@/ae/ae-sdk.service';
import {
  X_API_KEY,
  X_API_KEY_SECRET,
  X_CLIENT_ID,
  X_CLIENT_SECRET,
} from '@/configs/social';
import { toAettos } from '@aeternity/aepp-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  In,
  IsNull,
  LessThanOrEqual,
  QueryFailedError,
  Repository,
  Not,
} from 'typeorm';
import {
  PROFILE_X_POSTING_REWARD_AMOUNT_AE,
  PROFILE_X_POSTING_REWARD_ENABLE_POST_FETCH,
  PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS,
  PROFILE_X_POSTING_REWARD_KEYWORDS,
  PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS,
  PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS,
  PROFILE_X_POSTING_REWARD_SCAN_INTERVAL_SECONDS,
  PROFILE_X_POSTING_REWARD_THRESHOLD,
  PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY,
} from '../profile.constants';
import { ProfileCache } from '../entities/profile-cache.entity';
import { ProfileXPostingReward } from '../entities/profile-x-posting-reward.entity';
import { ProfileXVerificationReward } from '../entities/profile-x-verification-reward.entity';
import { ProfileSpendQueueService } from './profile-spend-queue.service';

interface XUserProfile {
  id: string;
  username: string;
}

interface XTweetItem {
  id: string;
  text: string;
  urls: string[];
}

@Injectable()
export class ProfileXPostingRewardService {
  private readonly logger = new Logger(ProfileXPostingRewardService.name);
  private static readonly ADDRESS_REGEX = /^ak_[1-9A-HJ-NP-Za-km-z]+$/;
  private static readonly RETRYABLE_STATUSES: Array<
    ProfileXPostingReward['status']
  > = ['pending', 'failed'];
  private static readonly DEFAULT_X_APP_TOKEN_TTL_SECONDS = 3600;
  private static readonly X_APP_TOKEN_MAX_ATTEMPTS = 3;
  private static readonly X_APP_TOKEN_RETRY_BASE_DELAY_MS = 500;
  private static readonly X_APP_TOKEN_FAILURE_COOLDOWN_MS = 60_000;
  private static readonly DEFAULT_RETRY_BATCH_SIZE = 100;
  private static readonly DEFAULT_MAX_TWEET_PAGE_COUNT = 20;
  private xAppAccessTokenCache: { token: string; expiresAtMs: number } | null =
    null;
  private xAppTokenFetchBlockedUntilMs = 0;
  private readonly processingByAddress = new Map<string, Promise<void>>();
  private isWorkerRunning = false;
  private static readonly X_API_BASE_URL = 'https://api.x.com';
  private static readonly X_READ_API_BASE_URLS = [
    'https://api.x.com',
    'https://api.twitter.com',
  ];

  constructor(
    @InjectRepository(ProfileXPostingReward)
    private readonly postingRewardRepository: Repository<ProfileXPostingReward>,
    @InjectRepository(ProfileCache)
    private readonly profileCacheRepository: Repository<ProfileCache>,
    @InjectRepository(ProfileXVerificationReward)
    private readonly verificationRewardRepository: Repository<ProfileXVerificationReward>,
    private readonly dataSource: DataSource,
    private readonly aeSdkService: AeSdkService,
    private readonly profileSpendQueueService: ProfileSpendQueueService,
  ) {}

  @Cron('*/30 * * * * *')
  async processDueRewards(): Promise<void> {
    if (this.isWorkerRunning) {
      console.log(
        '[processDueRewards] skipped because previous run is still active',
      );
      return;
    }
    this.isWorkerRunning = true;
    try {
      console.log('[processDueRewards] tick');
      const now = new Date();
      const dueRewards = await this.postingRewardRepository.find({
        where: [
          {
            status: In(ProfileXPostingRewardService.RETRYABLE_STATUSES),
            next_retry_at: IsNull(),
          },
          {
            status: In(ProfileXPostingRewardService.RETRYABLE_STATUSES),
            next_retry_at: LessThanOrEqual(now),
          },
        ],
        order: {
          next_retry_at: 'ASC',
          updated_at: 'ASC',
        },
        take: ProfileXPostingRewardService.DEFAULT_RETRY_BATCH_SIZE,
      });
      console.log('[processDueRewards] due rewards fetched', {
        count: dueRewards.length,
      });
      for (const reward of dueRewards) {
        await this.processAddressWithGuard(reward.address);
      }
    } catch (error) {
      this.logger.error('Failed to process due X posting rewards', error);
    } finally {
      this.isWorkerRunning = false;
    }
  }

  async upsertVerifiedCandidate(
    address: string,
    xUsername: string,
    verificationMicroTime?: string,
  ): Promise<void> {
    const normalizedXUsername = this.normalizeXUsername(xUsername);
    if (!normalizedXUsername) {
      this.logger.warn(
        `Skipping X posting reward candidate, invalid x username: ${xUsername}`,
      );
      return;
    }
    if (!ProfileXPostingRewardService.ADDRESS_REGEX.test(address || '')) {
      this.logger.warn(
        `Skipping X posting reward candidate, invalid account address: ${address}`,
      );
      return;
    }

    const existingReward = await this.postingRewardRepository.findOne({
      where: { address },
    });
    if (existingReward?.status === 'paid') {
      return;
    }
    const rewardEntry =
      existingReward ||
      this.postingRewardRepository.create({
        address,
        qualified_posts_count: 0,
      });
    const verificationDate = this.microTimeToDate(verificationMicroTime);
    if (!rewardEntry.verified_at) {
      rewardEntry.verified_at = verificationDate || new Date();
    } else if (
      verificationDate &&
      rewardEntry.verified_at &&
      verificationDate.getTime() < rewardEntry.verified_at.getTime()
    ) {
      rewardEntry.verified_at = verificationDate;
    }
    rewardEntry.x_username = normalizedXUsername;
    rewardEntry.error = null;
    rewardEntry.status = 'pending';
    rewardEntry.next_retry_at = new Date();
    await this.postingRewardRepository.save(rewardEntry);
    await this.processAddressWithGuard(address);
  }

  async getRewardStatus(address: string): Promise<{
    status: ProfileXPostingReward['status'] | 'not_started';
    x_username: string | null;
    x_user_id: string | null;
    qualified_posts_count: number;
    threshold: number;
    remaining_to_goal: number;
    tx_hash: string | null;
    retry_count: number;
    next_retry_at: Date | null;
    error: string | null;
  }> {
    let reward = await this.postingRewardRepository.findOne({
      where: { address },
    });
    if (!reward) {
      await this.bootstrapPostingCandidate(address);
      reward = await this.postingRewardRepository.findOne({
        where: { address },
      });
    }
    if (!reward) {
      return {
        status: 'not_started',
        x_username: null,
        x_user_id: null,
        qualified_posts_count: 0,
        threshold: PROFILE_X_POSTING_REWARD_THRESHOLD,
        remaining_to_goal: PROFILE_X_POSTING_REWARD_THRESHOLD,
        tx_hash: null,
        retry_count: 0,
        next_retry_at: null,
        error: null,
      };
    }
    if (
      reward.status === 'pending' &&
      !reward.x_user_id &&
      reward.error?.startsWith('Unable to resolve X user for @')
    ) {
      const maxAllowedNextRetryMs =
        Date.now() + PROFILE_X_POSTING_REWARD_SCAN_INTERVAL_SECONDS * 1000;
      const currentNextRetryMs = reward.next_retry_at
        ? reward.next_retry_at.getTime()
        : null;
      if (
        currentNextRetryMs === null ||
        currentNextRetryMs > maxAllowedNextRetryMs
      ) {
        reward.next_retry_at = new Date(maxAllowedNextRetryMs);
        await this.postingRewardRepository.save(reward);
      }
    }
    const qualifiedCount = Number(reward.qualified_posts_count || 0);
    return {
      status: reward.status,
      x_username: reward.x_username,
      x_user_id: reward.x_user_id,
      qualified_posts_count: qualifiedCount,
      threshold: PROFILE_X_POSTING_REWARD_THRESHOLD,
      remaining_to_goal: Math.max(
        PROFILE_X_POSTING_REWARD_THRESHOLD - qualifiedCount,
        0,
      ),
      tx_hash: reward.tx_hash,
      retry_count: reward.retry_count || 0,
      next_retry_at: reward.next_retry_at,
      error: reward.error,
    };
  }

  private async bootstrapPostingCandidate(address: string): Promise<void> {
    const cachedProfile = await this.profileCacheRepository.findOne({
      where: { address },
    });
    const xUsername = this.normalizeXUsername(cachedProfile?.x_username || '');
    if (!xUsername) {
      const verificationReward =
        await this.verificationRewardRepository.findOne({
          where: { address },
        });
      const fallbackUsername = this.normalizeXUsername(
        verificationReward?.x_username || '',
      );
      if (!fallbackUsername) {
        return;
      }
      await this.upsertVerifiedCandidate(address, fallbackUsername);
      return;
    }
    await this.upsertVerifiedCandidate(
      address,
      xUsername,
      cachedProfile?.last_seen_micro_time || undefined,
    );
  }

  private async processAddressWithGuard(address: string): Promise<void> {
    const existingInFlight = this.processingByAddress.get(address);
    if (existingInFlight) {
      return existingInFlight;
    }
    const work = this.processAddressInternal(address).catch(async (error) => {
      if (this.isXIdentityUniqueConstraintError(error)) {
        await this.postingRewardRepository.update(
          { address },
          {
            status: 'blocked_x_identity_conflict',
            error: 'X identity already claimed by another reward row',
            next_retry_at: null,
          },
        );
        return;
      }
      this.logger.error(
        `Failed to process X posting reward for ${address}`,
        error instanceof Error ? error.stack : String(error),
      );
    });
    this.processingByAddress.set(address, work);
    try {
      await work;
    } finally {
      if (this.processingByAddress.get(address) === work) {
        this.processingByAddress.delete(address);
      }
    }
  }

  private async processAddressInternal(address: string): Promise<void> {
    console.log('[processAddressInternal] START', { address });
    await this.dataSource.transaction(async (manager) => {
      const rewardRepo = manager.getRepository(ProfileXPostingReward);
      const rewardEntry = await rewardRepo
        .createQueryBuilder('reward')
        .setLock('pessimistic_write')
        .where('reward.address = :address', { address })
        .getOne();
      console.log('[processAddressInternal] rewardEntry loaded', {
        found: !!rewardEntry,
        status: rewardEntry?.status,
        x_username: rewardEntry?.x_username,
        x_user_id: rewardEntry?.x_user_id,
        qualified_posts_count: rewardEntry?.qualified_posts_count,
        last_scanned_tweet_id: rewardEntry?.last_scanned_tweet_id,
        verified_at: rewardEntry?.verified_at?.toISOString(),
      });
      if (!rewardEntry) {
        console.log('[processAddressInternal] EXIT: no reward entry');
        return;
      }
      if (rewardEntry.status === 'paid') {
        console.log('[processAddressInternal] EXIT: already paid');
        return;
      }
      if (rewardEntry.status === 'blocked_x_identity_conflict') {
        console.log(
          '[processAddressInternal] EXIT: blocked_x_identity_conflict',
        );
        return;
      }

      rewardEntry.last_attempt_at = new Date();
      const normalizedXUsername = this.normalizeXUsername(
        rewardEntry.x_username || '',
      );
      console.log('[processAddressInternal] normalized x_username', {
        raw: rewardEntry.x_username,
        normalized: normalizedXUsername,
      });
      if (!normalizedXUsername) {
        this.markRetry(
          rewardEntry,
          'Reward row has no valid X username yet',
          'pending',
        );
        await rewardRepo.save(rewardEntry);
        console.log('[processAddressInternal] EXIT: no valid x_username');
        return;
      }
      rewardEntry.x_username = normalizedXUsername;

      console.log('[processAddressInternal] config checks', {
        threshold: PROFILE_X_POSTING_REWARD_THRESHOLD,
        keywords: PROFILE_X_POSTING_REWARD_KEYWORDS,
      });
      if (
        !this.isValidPositiveInteger(PROFILE_X_POSTING_REWARD_THRESHOLD) ||
        PROFILE_X_POSTING_REWARD_THRESHOLD < 1
      ) {
        this.markRetry(
          rewardEntry,
          `Invalid PROFILE_X_POSTING_REWARD_THRESHOLD: ${PROFILE_X_POSTING_REWARD_THRESHOLD}`,
          'failed',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }
      if (!this.isValidAeAmount(PROFILE_X_POSTING_REWARD_AMOUNT_AE)) {
        this.markRetry(
          rewardEntry,
          `Invalid PROFILE_X_POSTING_REWARD_AMOUNT_AE: ${PROFILE_X_POSTING_REWARD_AMOUNT_AE}`,
          'failed',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }
      if (
        !this.isValidPositiveInteger(
          PROFILE_X_POSTING_REWARD_SCAN_INTERVAL_SECONDS,
        )
      ) {
        this.markRetry(
          rewardEntry,
          `Invalid PROFILE_X_POSTING_REWARD_SCAN_INTERVAL_SECONDS: ${PROFILE_X_POSTING_REWARD_SCAN_INTERVAL_SECONDS}`,
          'failed',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }
      if (
        !this.isValidPositiveInteger(
          PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS,
        )
      ) {
        this.markRetry(
          rewardEntry,
          `Invalid PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS: ${PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS}`,
          'failed',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }
      if (
        !this.isValidPositiveInteger(PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS)
      ) {
        this.markRetry(
          rewardEntry,
          `Invalid PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS: ${PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS}`,
          'failed',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }
      if (PROFILE_X_POSTING_REWARD_KEYWORDS.length === 0) {
        this.markRetry(
          rewardEntry,
          'PROFILE_X_POSTING_REWARD_KEYWORDS must contain at least one value',
          'failed',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }
      if (!PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY) {
        this.markRetry(
          rewardEntry,
          'PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY is not configured',
          'failed',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }
      if (
        !ProfileXPostingRewardService.ADDRESS_REGEX.test(
          rewardEntry.address || '',
        )
      ) {
        this.markRetry(rewardEntry, 'Reward row has invalid address', 'failed');
        await rewardRepo.save(rewardEntry);
        return;
      }
      if (PROFILE_X_POSTING_REWARD_ENABLE_POST_FETCH === false) {
        rewardEntry.error =
          'X posting reward post scan is temporarily disabled by configuration';
        rewardEntry.status = 'pending';
        rewardEntry.next_retry_at = this.getNextScanTime();
        await rewardRepo.save(rewardEntry);
        console.log('[processAddressInternal] EXIT: post fetch disabled');
        return;
      }

      const xUserProfile =
        await this.fetchXUserProfileByUsername(normalizedXUsername);
      console.log('[processAddressInternal] X user profile', {
        resolved: !!xUserProfile,
        id: xUserProfile?.id,
        username: xUserProfile?.username,
      });
      if (!xUserProfile) {
        this.markRetryForXUserLookup(
          rewardEntry,
          `Unable to resolve X user for @${normalizedXUsername}`,
        );
        await rewardRepo.save(rewardEntry);
        console.log('[processAddressInternal] EXIT: X user not resolved');
        return;
      }
      rewardEntry.x_username = this.normalizeXUsername(xUserProfile.username);
      rewardEntry.x_user_id = xUserProfile.id;

      const conflictingReward = await this.findConflictingReward(
        rewardRepo,
        rewardEntry.address,
        xUserProfile.id,
        rewardEntry.x_username,
      );
      console.log('[processAddressInternal] conflict check', {
        hasConflict: !!conflictingReward,
        conflictStatus: conflictingReward?.status,
      });
      if (conflictingReward?.status === 'paid') {
        rewardEntry.status = 'blocked_x_identity_conflict';
        rewardEntry.error = `X identity already rewarded on ${conflictingReward.address}`;
        rewardEntry.next_retry_at = null;
        await rewardRepo.save(rewardEntry);
        console.log('[processAddressInternal] EXIT: conflict with paid reward');
        return;
      }
      if (conflictingReward?.status === 'pending') {
        this.markRetry(
          rewardEntry,
          `X identity has active processing on ${conflictingReward.address}`,
          'pending',
        );
        await rewardRepo.save(rewardEntry);
        console.log(
          '[processAddressInternal] EXIT: conflict with pending reward',
        );
        return;
      }

      const postsResult = await this.fetchUserPostsSince(
        xUserProfile.id,
        rewardEntry.last_scanned_tweet_id,
        rewardEntry.last_scanned_tweet_id ? null : rewardEntry.verified_at,
      );
      console.log('[processAddressInternal] fetchUserPostsSince', {
        userId: xUserProfile.id,
        sinceId: rewardEntry.last_scanned_tweet_id,
        startTime: rewardEntry.last_scanned_tweet_id
          ? null
          : rewardEntry.verified_at?.toISOString(),
        postsCount: postsResult?.posts?.length ?? 0,
        newestTweetId: postsResult?.newestTweetId ?? null,
      });
      if (postsResult?.posts?.length) {
        postsResult.posts.forEach((post, i) => {
          const matches = this.matchesKeyword(post);
          console.log(`[processAddressInternal] post[${i}]`, {
            id: post.id,
            textPreview: (post.text || '').slice(0, 80),
            urls: post.urls?.length ? post.urls : [],
            matchesKeyword: matches,
          });
        });
      }
      if (!postsResult) {
        this.markRetry(
          rewardEntry,
          `Failed to fetch posts for @${rewardEntry.x_username}`,
          'pending',
        );
        await rewardRepo.save(rewardEntry);
        console.log('[processAddressInternal] EXIT: fetch posts failed');
        return;
      }

      const newQualifiedCount = postsResult.posts.filter((post) =>
        this.matchesKeyword(post),
      ).length;
      rewardEntry.qualified_posts_count =
        Number(rewardEntry.qualified_posts_count || 0) + newQualifiedCount;
      if (postsResult.newestTweetId) {
        rewardEntry.last_scanned_tweet_id = postsResult.newestTweetId;
      }
      rewardEntry.error = null;

      console.log('[processAddressInternal] qualified count update', {
        newQualifiedCount,
        previousCount:
          Number(rewardEntry.qualified_posts_count || 0) - newQualifiedCount,
        totalQualifiedCount: rewardEntry.qualified_posts_count,
        threshold: PROFILE_X_POSTING_REWARD_THRESHOLD,
        last_scanned_tweet_id: rewardEntry.last_scanned_tweet_id,
      });

      if (
        rewardEntry.qualified_posts_count < PROFILE_X_POSTING_REWARD_THRESHOLD
      ) {
        rewardEntry.next_retry_at = this.getNextScanTime();
        await rewardRepo.save(rewardEntry);
        console.log(
          '[processAddressInternal] EXIT: below threshold, next_retry_at set',
        );
        return;
      }

      console.log(
        '[processAddressInternal] threshold reached, attempting payout',
      );
      const rewardAmountAettos = this.getRewardAmountAettos();
      if (!rewardAmountAettos) {
        this.markRetry(
          rewardEntry,
          'Failed to convert posting reward amount to aettos',
          'failed',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }

      try {
        await this.profileSpendQueueService.enqueueSpend(
          PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY,
          async () => {
            const rewardAccount =
              this.profileSpendQueueService.getRewardAccount(
                PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY,
                'PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY',
              );
            const spendResult = await this.aeSdkService.sdk.spend(
              rewardAmountAettos,
              rewardEntry.address as `ak_${string}`,
              { onAccount: rewardAccount },
            );
            rewardEntry.tx_hash = spendResult.hash || null;
            rewardEntry.status = 'paid';
            rewardEntry.error = null;
            rewardEntry.next_retry_at = null;
            await rewardRepo.save(rewardEntry);
            this.logger.log(
              `Sent ${PROFILE_X_POSTING_REWARD_AMOUNT_AE} AE X posting reward to ${rewardEntry.address}`,
            );
            console.log('[processAddressInternal] EXIT: payout success');
          },
        );
      } catch (error) {
        this.markRetry(
          rewardEntry,
          error instanceof Error
            ? error.message
            : String(error || 'Unknown error'),
          'pending',
        );
        await rewardRepo.save(rewardEntry);
        this.logger.warn(
          `Failed to send X posting reward to ${rewardEntry.address}, scheduled retry`,
        );
        console.log('[processAddressInternal] EXIT: payout failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      console.log('[processAddressInternal] END transaction');
    });
  }

  private normalizeXUsername(value: string): string | null {
    if (!value) {
      return null;
    }
    const normalized = value.trim().toLowerCase().replace(/^@+/, '');
    return normalized || null;
  }

  private isValidAeAmount(value: string): boolean {
    if (!/^\d+(\.\d+)?$/.test(value)) {
      return false;
    }
    return Number(value) > 0;
  }

  private isValidPositiveInteger(value: number): boolean {
    return Number.isInteger(value) && value > 0;
  }

  private getRewardAmountAettos(): string | null {
    try {
      const amount = toAettos(PROFILE_X_POSTING_REWARD_AMOUNT_AE);
      if (!/^\d+$/.test(amount) || amount === '0') {
        this.logger.error(
          `Skipping X posting reward, converted aettos amount is invalid: ${amount}`,
        );
        return null;
      }
      return amount;
    } catch (error) {
      this.logger.error(
        'Skipping X posting reward, failed to convert amount to aettos',
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  private markRetry(
    rewardEntry: ProfileXPostingReward,
    errorMessage: string,
    status: 'pending' | 'failed',
  ): void {
    const retryCount = (rewardEntry.retry_count || 0) + 1;
    rewardEntry.retry_count = retryCount;
    rewardEntry.status = status;
    rewardEntry.error = errorMessage;
    rewardEntry.next_retry_at = new Date(
      Date.now() + this.getRetryDelaySeconds(retryCount) * 1000,
    );
  }

  private markRetryForXUserLookup(
    rewardEntry: ProfileXPostingReward,
    errorMessage: string,
  ): void {
    rewardEntry.retry_count = (rewardEntry.retry_count || 0) + 1;
    rewardEntry.status = 'pending';
    rewardEntry.error = errorMessage;
    // Keep username-resolution retries frequent to avoid long stalls.
    rewardEntry.next_retry_at = this.getNextScanTime();
  }

  private getRetryDelaySeconds(retryCount: number): number {
    const base = Math.max(PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS, 1);
    const max = Math.max(PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS, base);
    const exponent = Math.max(retryCount - 1, 0);
    const delay = base * 2 ** Math.min(exponent, 10);
    return Math.min(delay, max);
  }

  private getNextScanTime(): Date {
    return new Date(
      Date.now() + PROFILE_X_POSTING_REWARD_SCAN_INTERVAL_SECONDS * 1000,
    );
  }

  private matchesKeyword(post: XTweetItem): boolean {
    const normalizedText = (post.text || '').toLowerCase();
    const normalizedUrls = (post.urls || [])
      .map((url) => (url || '').toLowerCase())
      .filter(Boolean);
    return PROFILE_X_POSTING_REWARD_KEYWORDS.some((keyword) => {
      if (normalizedText.includes(keyword)) {
        return true;
      }
      return normalizedUrls.some((url) => url.includes(keyword));
    });
  }

  private async fetchXUserProfileByUsername(
    username: string,
  ): Promise<XUserProfile | null> {
    const token = await this.getXAppAccessToken();
    if (!token) {
      return null;
    }
    try {
      const { response, body, baseUrl } = await this.fetchXReadWithAuthFallback(
        `/2/users/by/username/${encodeURIComponent(username)}?user.fields=id,username`,
        token,
      );
      if (!response.ok || !(body as any)?.data?.id) {
        this.logger.warn('X username lookup failed for posting reward', {
          username,
          base_url: baseUrl,
          status: response.status,
          detail: (body as any)?.detail || (body as any)?.title,
        });
        console.log('[x-posting-reward] user lookup failed', {
          username,
          baseUrl,
          status: response.status,
          detail: (body as any)?.detail || (body as any)?.title,
          body: body || null,
        });
        return null;
      }
      return {
        id: String((body as any).data.id),
        username: String((body as any).data.username || username),
      };
    } catch (error) {
      this.logger.warn(
        `Failed to fetch X user profile for @${username}: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.log('[x-posting-reward] user lookup request error', {
        username,
        baseUrl: 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async fetchUserPostsSince(
    userId: string,
    sinceId?: string | null,
    startTime?: Date | null,
  ): Promise<{ posts: XTweetItem[]; newestTweetId: string | null } | null> {
    const token = await this.getXAppAccessToken();
    if (!token) {
      return null;
    }
    let pageCount = 0;
    let nextToken: string | null = null;
    let newestTweetId: string | null = null;
    const postsById = new Map<string, XTweetItem>();

    while (true) {
      pageCount += 1;
      if (
        pageCount > ProfileXPostingRewardService.DEFAULT_MAX_TWEET_PAGE_COUNT
      ) {
        this.logger.warn(
          `Reached X posting reward pagination cap for user ${userId}; retrying later`,
        );
        return null;
      }
      const params = new URLSearchParams({
        max_results: '100',
        'tweet.fields': 'created_at,entities',
        exclude: 'retweets,replies',
      });
      if (sinceId) {
        params.set('since_id', sinceId);
      } else if (startTime) {
        params.set('start_time', startTime.toISOString());
      }
      if (nextToken) {
        params.set('pagination_token', nextToken);
      }
      try {
        const { response, body, baseUrl } =
          await this.fetchXReadWithAuthFallback(
            `/2/users/${encodeURIComponent(userId)}/tweets?${params.toString()}`,
            token,
          );
        if (!response.ok) {
          this.logger.warn('X tweets fetch failed for posting reward', {
            user_id: userId,
            base_url: baseUrl,
            status: response.status,
            detail: (body as any)?.detail || (body as any)?.title,
          });
          console.log('[x-posting-reward] tweets fetch failed', {
            userId,
            baseUrl,
            status: response.status,
            detail: (body as any)?.detail || (body as any)?.title,
            body: body || null,
          });
          return null;
        }
        const pagePosts = Array.isArray((body as any)?.data)
          ? (body as any).data
              .map((item: any) => ({
                id: String(item?.id || ''),
                text: String(item?.text || ''),
                urls: this.extractCandidateUrls(item),
              }))
              .filter((item: XTweetItem) => !!item.id)
          : [];
        for (const post of pagePosts) {
          postsById.set(post.id, post);
          newestTweetId = this.pickNewestTweetId(newestTweetId, post.id);
        }
        const newestFromMeta = (body as any)?.meta?.newest_id
          ? String((body as any).meta.newest_id)
          : null;
        newestTweetId = this.pickNewestTweetId(newestTweetId, newestFromMeta);
        nextToken = (body as any)?.meta?.next_token
          ? String((body as any).meta.next_token)
          : null;
        if (!nextToken) {
          return {
            posts: Array.from(postsById.values()),
            newestTweetId,
          };
        }
      } catch (error) {
        this.logger.warn(
          `Failed to fetch X posts for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        console.log('[x-posting-reward] tweets fetch request error', {
          userId,
          baseUrl: 'unknown',
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }
  }

  private async findConflictingReward(
    rewardRepo: Repository<ProfileXPostingReward>,
    address: string,
    xUserId: string | null,
    xUsername: string | null,
  ): Promise<ProfileXPostingReward | null> {
    const activeStatuses: Array<ProfileXPostingReward['status']> = [
      'pending',
      'paid',
    ];
    if (xUserId) {
      const byUserId = await rewardRepo.findOne({
        where: {
          x_user_id: xUserId,
          address: Not(address),
          status: In(activeStatuses),
        },
      });
      if (byUserId) {
        return byUserId;
      }
    }
    if (xUsername) {
      const byUsername = await rewardRepo.findOne({
        where: {
          x_username: xUsername,
          address: Not(address),
          status: In(activeStatuses),
        },
      });
      if (byUsername) {
        return byUsername;
      }
    }
    return null;
  }

  private pickNewestTweetId(
    current: string | null,
    candidate: string | null,
  ): string | null {
    if (!candidate) {
      return current;
    }
    if (!current) {
      return candidate;
    }
    try {
      return BigInt(candidate) > BigInt(current) ? candidate : current;
    } catch {
      return candidate > current ? candidate : current;
    }
  }

  private extractCandidateUrls(tweetItem: any): string[] {
    const entityUrls = Array.isArray(tweetItem?.entities?.urls)
      ? tweetItem.entities.urls
      : [];
    const results = new Set<string>();
    for (const item of entityUrls) {
      const candidates = [
        item?.expanded_url,
        item?.display_url,
        item?.unwound_url,
        item?.url,
      ];
      for (const candidate of candidates) {
        const value = String(candidate || '').trim();
        if (value) {
          results.add(value);
        }
      }
    }
    return Array.from(results.values());
  }

  private microTimeToDate(value?: string): Date | null {
    if (!value) {
      return null;
    }
    try {
      const raw = BigInt(value);
      if (raw <= 0n) {
        return null;
      }
      // Middleware micro_time is microseconds.
      if (raw > 1_000_000_000_000_000n) {
        return new Date(Number(raw / 1000n));
      }
      if (raw > 1_000_000_000_000n) {
        return new Date(Number(raw / 1000n));
      }
      if (raw > 10_000_000_000n) {
        return new Date(Number(raw));
      }
      return new Date(Number(raw) * 1000);
    } catch {
      return null;
    }
  }

  private isXIdentityUniqueConstraintError(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const payload = (error as any)?.driverError || {};
    const code = payload.code?.toString?.() || '';
    const constraint = payload.constraint?.toString?.() || '';
    return (
      code === '23505' &&
      constraint.includes('ux_profile_x_posting_rewards_x_user_id')
    );
  }

  private async getXAppAccessToken(): Promise<string | null> {
    if (
      this.xAppAccessTokenCache &&
      this.xAppAccessTokenCache.expiresAtMs > Date.now()
    ) {
      // #region agent log
      this.emitDebugLog(
        'H5',
        'profile-x-posting-reward.service.ts:getXAppAccessToken:cache-hit',
        'Using cached X app token',
        {
          cacheExpiresInMs: this.xAppAccessTokenCache.expiresAtMs - Date.now(),
        },
      );
      // #endregion
      return this.xAppAccessTokenCache.token;
    }
    if (this.xAppTokenFetchBlockedUntilMs > Date.now()) {
      // #region agent log
      this.emitDebugLog(
        'H5',
        'profile-x-posting-reward.service.ts:getXAppAccessToken:cooldown-block',
        'Token fetch blocked by cooldown',
        {
          blockedUntilMs: this.xAppTokenFetchBlockedUntilMs,
          remainingMs: this.xAppTokenFetchBlockedUntilMs - Date.now(),
        },
      );
      // #endregion
      return null;
    }
    const appKey = X_API_KEY || X_CLIENT_ID;
    const appSecret = X_API_KEY_SECRET || X_CLIENT_SECRET;
    const credentialSource =
      X_API_KEY && X_API_KEY_SECRET
        ? 'x_api_key_pair'
        : 'x_client_pair_fallback';
    if (!appKey || !appSecret) {
      this.logger.warn(
        'Skipping X posting reward, app token credentials are required',
      );
      return null;
    }
    try {
      const basicAuth = Buffer.from(`${appKey}:${appSecret}`, 'utf-8').toString(
        'base64',
      );
      let payload: any = {};
      let lastStatus: number | null = null;
      let lastBaseUrl = 'https://api.x.com';
      let lastDetail: string | null = null;
      const tokenEndpoints = [
        {
          baseUrl: 'https://api.x.com',
          url: 'https://api.x.com/oauth2/token',
          body: new URLSearchParams({ grant_type: 'client_credentials' }),
        },
        {
          baseUrl: 'https://api.twitter.com',
          url: 'https://api.twitter.com/oauth2/token',
          body: new URLSearchParams({ grant_type: 'client_credentials' }),
        },
      ];
      for (
        let attempt = 1;
        attempt <= ProfileXPostingRewardService.X_APP_TOKEN_MAX_ATTEMPTS;
        attempt += 1
      ) {
        let shouldRetry = false;
        let hadNetworkError = false;
        try {
          // #region agent log
          this.emitDebugLog(
            'H1',
            'profile-x-posting-reward.service.ts:getXAppAccessToken:attempt-start',
            'Starting token fetch attempt',
            {
              attempt,
              endpoints: tokenEndpoints.map((item) => item.baseUrl),
              credentialSource,
              credentialIdLength: appKey.length,
              credentialIdContainsColon: appKey.includes(':'),
              credentialIdLooksOauthClient:
                appKey.includes(':') || appKey.endsWith('ci'),
            },
          );
          // #endregion
          for (const endpoint of tokenEndpoints) {
            const response = await this.fetchWithTimeout(endpoint.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: `Basic ${basicAuth}`,
              },
              body: endpoint.body.toString(),
            });
            payload = await response.json().catch(() => ({}));
            lastStatus = response.status;
            lastBaseUrl = endpoint.baseUrl;
            lastDetail = this.extractXApiErrorDetail(payload);
            // #region agent log
            this.emitDebugLog(
              'H1',
              'profile-x-posting-reward.service.ts:getXAppAccessToken:endpoint-response',
              'Token endpoint response',
              {
                attempt,
                baseUrl: endpoint.baseUrl,
                status: response.status,
                hasAccessToken: Boolean((payload as any)?.access_token),
                tokenType: (payload as any)?.token_type || null,
                detail: lastDetail,
                wwwAuthenticate: response.headers?.get?.('www-authenticate'),
              },
            );
            // #endregion
            if (response.ok && (payload as any)?.access_token) {
              const expiresInSeconds = Number((payload as any).expires_in);
              const ttlSeconds =
                Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
                  ? expiresInSeconds
                  : ProfileXPostingRewardService.DEFAULT_X_APP_TOKEN_TTL_SECONDS;
              this.xAppAccessTokenCache = {
                token: (payload as any).access_token,
                expiresAtMs: Date.now() + Math.max(ttlSeconds - 60, 30) * 1000,
              };
              this.xAppTokenFetchBlockedUntilMs = 0;
              // #region agent log
              this.emitDebugLog(
                'H2',
                'profile-x-posting-reward.service.ts:getXAppAccessToken:success',
                'Token fetch succeeded',
                {
                  attempt,
                  baseUrl: endpoint.baseUrl,
                  expiresInSeconds: Number.isFinite(expiresInSeconds)
                    ? expiresInSeconds
                    : null,
                  tokenType: (payload as any)?.token_type || null,
                },
              );
              // #endregion
              return this.xAppAccessTokenCache.token;
            }
            if (this.shouldRetryXTokenFetch(response.status)) {
              shouldRetry = true;
            }
          }
        } catch (error) {
          hadNetworkError = true;
          if (
            attempt === ProfileXPostingRewardService.X_APP_TOKEN_MAX_ATTEMPTS
          ) {
            throw error;
          }
        }
        if (
          attempt === ProfileXPostingRewardService.X_APP_TOKEN_MAX_ATTEMPTS ||
          (!shouldRetry && !hadNetworkError)
        ) {
          break;
        }
        const delayMs =
          ProfileXPostingRewardService.X_APP_TOKEN_RETRY_BASE_DELAY_MS *
          2 ** (attempt - 1);
        await this.sleep(delayMs);
      }
      this.logger.warn('Failed to obtain X app access token for post checks', {
        base_url: lastBaseUrl,
        status: lastStatus,
        error: (payload as any)?.error,
        error_description: (payload as any)?.error_description,
        detail:
          lastDetail || (payload as any)?.detail || (payload as any)?.title,
      });
      console.log('[x-posting-reward] app token fetch failed', {
        baseUrl: lastBaseUrl,
        status: lastStatus,
        payload: payload || null,
        detail: lastDetail,
      });
      this.xAppTokenFetchBlockedUntilMs =
        Date.now() +
        ProfileXPostingRewardService.X_APP_TOKEN_FAILURE_COOLDOWN_MS;
      return null;
    } catch (error) {
      this.logger.warn(
        `Failed to obtain X app access token for post checks: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async fetchWithTimeout(
    input: string,
    init?: RequestInit,
  ): Promise<Response> {
    const timeoutMs = this.isValidPositiveInteger(
      PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS,
    )
      ? PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS
      : 5000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, {
        ...(init || {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchXReadWithAuthFallback(
    pathAndQuery: string,
    bearerToken: string,
  ): Promise<{ response: Response; body: any; baseUrl: string }> {
    let lastResponse: Response | null = null;
    let lastBody: any = {};
    let lastBaseUrl = ProfileXPostingRewardService.X_API_BASE_URL;

    for (const baseUrl of ProfileXPostingRewardService.X_READ_API_BASE_URLS) {
      const endpoint = `${baseUrl}${pathAndQuery}`;
      // #region agent log
      this.emitDebugLog(
        'H3',
        'profile-x-posting-reward.service.ts:fetchXReadWithAuthFallback:request',
        'Calling X read endpoint',
        {
          baseUrl,
          pathAndQuery,
          tokenLength: String(bearerToken || '').trim().length,
        },
      );
      // #endregion
      const response = await this.fetchWithTimeout(endpoint, {
        headers: {
          Authorization: `Bearer ${String(bearerToken || '').trim()}`,
        },
      });
      const body = await response.json().catch(() => ({}));
      lastResponse = response;
      lastBody = body;
      lastBaseUrl = baseUrl;
      // #region agent log
      this.emitDebugLog(
        'H4',
        'profile-x-posting-reward.service.ts:fetchXReadWithAuthFallback:response',
        'X read endpoint response',
        {
          baseUrl,
          status: response.status,
          detail: this.extractXApiErrorDetail(body),
          unsupportedAuth: this.isUnsupportedAuthenticationError(
            response.status,
            body,
          ),
        },
      );
      // #endregion
      if (response.ok) {
        return { response, body, baseUrl };
      }
      if (!this.isUnsupportedAuthenticationError(response.status, body)) {
        return { response, body, baseUrl };
      }
    }

    if (!lastResponse) {
      throw new Error('No response received from X read endpoints');
    }
    return { response: lastResponse, body: lastBody, baseUrl: lastBaseUrl };
  }

  private isUnsupportedAuthenticationError(status: number, body: any): boolean {
    if (status !== 403) {
      return false;
    }
    const detail = String(body?.detail || body?.title || '').toLowerCase();
    return (
      detail.includes('unsupported authentication') ||
      detail.includes('authenticating with unknown')
    );
  }

  private shouldRetryXTokenFetch(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private extractXApiErrorDetail(body: any): string | null {
    if (!body || typeof body !== 'object') {
      return null;
    }
    const topLevel =
      body.error_description || body.detail || body.title || body.error || null;
    if (topLevel) {
      return String(topLevel);
    }
    const firstError = Array.isArray(body.errors) ? body.errors[0] : null;
    if (!firstError || typeof firstError !== 'object') {
      return null;
    }
    const code = firstError.code ? `code=${String(firstError.code)}` : null;
    const message = firstError.message ? String(firstError.message) : null;
    if (code && message) {
      return `${code} ${message}`;
    }
    return code || message || null;
  }

  private emitDebugLog(
    hypothesisId: string,
    location: string,
    message: string,
    data: Record<string, unknown>,
  ): void {
    // #region agent log
    fetch('http://127.0.0.1:7624/ingest/a577cf7f-0199-426a-8d18-feba5b660f82', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': '1e22e7',
      },
      body: JSON.stringify({
        sessionId: '1e22e7',
        runId: 'run1',
        hypothesisId,
        location,
        message,
        data,
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
