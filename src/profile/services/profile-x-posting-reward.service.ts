import { AeSdkService } from '@/ae/ae-sdk.service';
import {
  X_API_KEY,
  X_API_KEY_SECRET,
  X_CLIENT_ID,
  X_CLIENT_SECRET,
} from '@/configs/social';
import { toAettos } from '@aeternity/aepp-sdk';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
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
  PROFILE_X_POSTING_REWARD_ENABLED,
  PROFILE_X_POSTING_REWARD_ENABLE_POST_FETCH,
  PROFILE_X_POSTING_REWARD_ENABLE_PERIODIC_RECHECKS,
  PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS,
  PROFILE_X_POSTING_REWARD_KEYWORDS,
  PROFILE_X_POSTING_REWARD_MANUAL_RECHECK_COOLDOWN_SECONDS,
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

interface XPostFetchResult {
  posts: XTweetItem[];
  newestTweetId: string | null;
  truncated: boolean;
}

type PublicPostingRewardStatus = 'not_started' | 'pending' | 'paid' | 'failed';

type PublicPostingRewardStatusPayload = {
  status: PublicPostingRewardStatus;
  x_username: string | null;
  x_user_id: string | null;
  qualified_posts_count: number;
  threshold: number;
  remaining_to_goal: number;
  tx_hash: string | null;
  retry_count: number;
  next_retry_at: Date | null;
  error: string | null;
};

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
  private static readonly MAX_RECENT_SOURCE_TX_HASHES = 5000;
  private static readonly PAYOUT_IN_PROGRESS_TX_HASH =
    '__posting_reward_payout_in_progress__';
  private xAppAccessTokenCache: { token: string; expiresAtMs: number } | null =
    null;
  private xAppTokenFetchBlockedUntilMs = 0;
  private readonly processingByAddress = new Map<string, Promise<void>>();
  private readonly manualRecheckBlockedUntilByAddress = new Map<
    string,
    number
  >();
  private readonly recentSourceTxHashes = new Set<string>();
  private readonly recentSourceTxHashQueue: string[] = [];
  private isWorkerRunning = false;
  private static readonly X_API_BASE_URL = 'https://api.x.com';
  private static readonly X_READ_API_BASE_URLS = [
    'https://api.x.com',
    'https://api.twitter.com',
  ];
  private preferredXReadBaseUrl: string | null = null;

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
    if (!PROFILE_X_POSTING_REWARD_ENABLED) {
      return;
    }
    if (!PROFILE_X_POSTING_REWARD_ENABLE_PERIODIC_RECHECKS) {
      return;
    }
    if (this.isWorkerRunning) {
      return;
    }
    this.isWorkerRunning = true;
    try {
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
    if (!PROFILE_X_POSTING_REWARD_ENABLED) {
      return;
    }
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
    rewardEntry.next_retry_at =
      PROFILE_X_POSTING_REWARD_ENABLE_PERIODIC_RECHECKS ? new Date() : null;
    await this.postingRewardRepository.save(rewardEntry);
    await this.processAddressWithGuard(address);
  }

  async upsertVerifiedCandidateFromTx(
    address: string,
    xUsername: string,
    verificationMicroTime?: string,
    sourceTxHash?: string,
  ): Promise<void> {
    if (!PROFILE_X_POSTING_REWARD_ENABLED) {
      return;
    }
    const normalizedHash = String(sourceTxHash || '').trim();
    if (normalizedHash) {
      if (this.recentSourceTxHashes.has(normalizedHash)) {
        return;
      }
      this.recentSourceTxHashes.add(normalizedHash);
      this.recentSourceTxHashQueue.push(normalizedHash);
      if (
        this.recentSourceTxHashQueue.length >
        ProfileXPostingRewardService.MAX_RECENT_SOURCE_TX_HASHES
      ) {
        const oldest = this.recentSourceTxHashQueue.shift();
        if (oldest) {
          this.recentSourceTxHashes.delete(oldest);
        }
      }
    }
    await this.upsertVerifiedCandidate(
      address,
      xUsername,
      verificationMicroTime,
    );
  }

  async getRewardStatus(
    address: string,
  ): Promise<PublicPostingRewardStatusPayload> {
    this.assertValidAddress(address);
    const reward = await this.postingRewardRepository.findOne({
      where: { address },
    });
    if (!PROFILE_X_POSTING_REWARD_ENABLED) {
      if (reward?.status === 'paid') {
        return this.toPublicRewardStatus(reward);
      }
      return {
        ...this.toPublicRewardStatus(null),
        error: 'Posting rewards are temporarily unavailable.',
      };
    }
    return this.toPublicRewardStatus(reward);
  }

  async requestManualRecheck(
    address: string,
  ): Promise<PublicPostingRewardStatusPayload> {
    this.assertValidAddress(address);
    if (!PROFILE_X_POSTING_REWARD_ENABLED) {
      throw new HttpException(
        {
          status: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Posting rewards are temporarily unavailable.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const cooldownUntilMs = this.manualRecheckBlockedUntilByAddress.get(address) || 0;
    if (cooldownUntilMs > Date.now()) {
      throw new HttpException(
        {
          status: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Manual X posting reward recheck is cooling down',
          nextAllowedAt: new Date(cooldownUntilMs).toISOString(),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const reward = await this.prepareManualRecheckCandidate(address);
    if (
      reward.status === 'paid' ||
      reward.status === 'blocked_x_identity_conflict'
    ) {
      return this.getRewardStatus(address);
    }
    const nextManualRecheckTime = this.getNextManualRecheckTime();
    if (nextManualRecheckTime) {
      this.manualRecheckBlockedUntilByAddress.set(
        address,
        nextManualRecheckTime.getTime(),
      );
    }
    await this.processAddressWithGuard(address);
    return this.getRewardStatus(address);
  }

  private async prepareManualRecheckCandidate(
    address: string,
  ): Promise<ProfileXPostingReward> {
    const cachedProfile = await this.profileCacheRepository.findOne({
      where: { address },
    });
    const linkedXUsername = this.normalizeXUsername(
      cachedProfile?.x_username || '',
    );
    if (!linkedXUsername) {
      throw new BadRequestException(
        'X profile is not linked for this address yet',
      );
    }
    let reward = await this.postingRewardRepository.findOne({
      where: { address },
    });
    if (!reward) {
      reward = this.postingRewardRepository.create({
        address,
        x_username: linkedXUsername,
        qualified_posts_count: 0,
        status: 'pending',
        verified_at:
          this.microTimeToDate(
            cachedProfile?.last_seen_micro_time || undefined,
          ) || new Date(),
        next_retry_at: null,
      });
      return this.postingRewardRepository.save(reward);
    }
    reward.x_username = linkedXUsername;
    if (!reward.verified_at) {
      reward.verified_at =
        this.microTimeToDate(
          cachedProfile?.last_seen_micro_time || undefined,
        ) || new Date();
    }
    reward.error = null;
    return this.postingRewardRepository.save(reward);
  }

  private async bootstrapPostingCandidate(address: string): Promise<void> {
    const cachedProfile = await this.profileCacheRepository.findOne({
      where: { address },
    });
    const xUsername = this.normalizeXUsername(cachedProfile?.x_username || '');
    if (!xUsername) {
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
    const rewardEntry = await this.postingRewardRepository.findOne({
      where: { address },
    });
    if (!rewardEntry) {
      return;
    }
    if (rewardEntry.status === 'paid') {
      return;
    }
    if (rewardEntry.status === 'blocked_x_identity_conflict') {
      return;
    }
    if (
      rewardEntry.tx_hash ===
      ProfileXPostingRewardService.PAYOUT_IN_PROGRESS_TX_HASH
    ) {
      return;
    }

    rewardEntry.last_attempt_at = new Date();
    const normalizedXUsername = this.normalizeXUsername(
      rewardEntry.x_username || '',
    );
    if (!normalizedXUsername) {
      this.markRetry(rewardEntry, 'missing_x_username', 'pending');
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    rewardEntry.x_username = normalizedXUsername;

    if (
      !this.isValidPositiveInteger(PROFILE_X_POSTING_REWARD_THRESHOLD) ||
      PROFILE_X_POSTING_REWARD_THRESHOLD < 1
    ) {
      this.markRetry(rewardEntry, 'invalid_threshold', 'failed');
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    if (!this.isValidAeAmount(PROFILE_X_POSTING_REWARD_AMOUNT_AE)) {
      this.markRetry(rewardEntry, 'invalid_reward_amount', 'failed');
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    if (
      !this.isValidPositiveInteger(
        PROFILE_X_POSTING_REWARD_SCAN_INTERVAL_SECONDS,
      )
    ) {
      this.markRetry(rewardEntry, 'invalid_scan_interval', 'failed');
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    if (
      !this.isValidPositiveInteger(PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS)
    ) {
      this.markRetry(rewardEntry, 'invalid_retry_base', 'failed');
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    if (
      !this.isValidPositiveInteger(PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS)
    ) {
      this.markRetry(rewardEntry, 'invalid_retry_max', 'failed');
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    if (PROFILE_X_POSTING_REWARD_KEYWORDS.length === 0) {
      this.markRetry(rewardEntry, 'missing_keywords', 'failed');
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    if (!PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY) {
      this.markRetry(rewardEntry, 'reward_wallet_not_configured', 'failed');
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    if (
      !ProfileXPostingRewardService.ADDRESS_REGEX.test(
        rewardEntry.address || '',
      )
    ) {
      this.markRetry(rewardEntry, 'invalid_address', 'failed');
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    if (PROFILE_X_POSTING_REWARD_ENABLE_POST_FETCH === false) {
      rewardEntry.error = 'post_fetch_disabled';
      rewardEntry.status = 'pending';
      rewardEntry.next_retry_at = null;
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }

    const xUserProfile = rewardEntry.x_user_id
      ? {
          id: String(rewardEntry.x_user_id),
          username: normalizedXUsername,
        }
      : await this.fetchXUserProfileByUsername(normalizedXUsername);
    if (!xUserProfile) {
      this.markRetryForXUserLookup(rewardEntry, 'x_user_lookup_failed');
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    rewardEntry.x_username = this.normalizeXUsername(xUserProfile.username);
    rewardEntry.x_user_id = xUserProfile.id;

    const conflictingReward = await this.findConflictingReward(
      this.postingRewardRepository,
      rewardEntry.address,
      xUserProfile.id,
      rewardEntry.x_username,
    );
    if (conflictingReward?.status === 'paid') {
      rewardEntry.status = 'blocked_x_identity_conflict';
      rewardEntry.error = 'x_identity_already_rewarded';
      rewardEntry.next_retry_at = null;
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }
    if (conflictingReward?.status === 'pending') {
      this.markRetry(rewardEntry, 'x_identity_processing_elsewhere', 'pending');
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }

    const postsResult = await this.fetchUserPostsSince(
      xUserProfile.id,
      rewardEntry.last_scanned_tweet_id,
      rewardEntry.last_scanned_tweet_id ? null : rewardEntry.verified_at,
    );
    if (!postsResult) {
      this.markRetry(rewardEntry, 'x_posts_fetch_failed', 'pending');
      await this.postingRewardRepository.save(rewardEntry);
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
    rewardEntry.error = postsResult.truncated ? 'x_posts_scan_truncated' : null;

    if (
      rewardEntry.qualified_posts_count < PROFILE_X_POSTING_REWARD_THRESHOLD
    ) {
      rewardEntry.next_retry_at =
        PROFILE_X_POSTING_REWARD_ENABLE_PERIODIC_RECHECKS
          ? this.getNextScanTime()
          : null;
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }

    const rewardAmountAettos = this.getRewardAmountAettos();
    if (!rewardAmountAettos) {
      this.markRetry(rewardEntry, 'reward_amount_conversion_failed', 'failed');
      await this.postingRewardRepository.save(rewardEntry);
      return;
    }

    const payoutClaimed = await this.claimPayoutAttempt(rewardEntry.address);
    if (!payoutClaimed) {
      return;
    }

    let spendBroadcastHash: string | null = null;
    try {
      await this.profileSpendQueueService.enqueueSpend(
        PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY,
        async () => {
          const rewardAccount = this.profileSpendQueueService.getRewardAccount(
            PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY,
            'PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY',
          );
          const spendResult = await this.aeSdkService.sdk.spend(
            rewardAmountAettos,
            rewardEntry.address as `ak_${string}`,
            { onAccount: rewardAccount },
          );
          spendBroadcastHash = spendResult.hash || 'broadcasted';
          await this.postingRewardRepository.update(
            { address: rewardEntry.address },
            {
              tx_hash: spendResult.hash || null,
              status: 'paid',
              error: null,
              next_retry_at: null,
              last_attempt_at: new Date(),
            },
          );
          this.logger.log(
            `Sent ${PROFILE_X_POSTING_REWARD_AMOUNT_AE} AE X posting reward to ${rewardEntry.address}`,
          );
        },
      );
    } catch (error) {
      if (spendBroadcastHash) {
        await this.postingRewardRepository.update(
          { address: rewardEntry.address },
          {
            error: 'payout_confirmation_pending',
            next_retry_at: null,
            last_attempt_at: new Date(),
          },
        );
        this.logger.error(
          `Posting reward payout broadcasted for ${rewardEntry.address} but final DB state could not be confirmed`,
          error instanceof Error ? error.stack : String(error),
        );
        return;
      }
      const retryReward =
        (await this.postingRewardRepository.findOne({
          where: { address: rewardEntry.address },
        })) || rewardEntry;
      retryReward.tx_hash = null;
      this.markRetry(retryReward, 'payout_send_failed', 'pending');
      await this.postingRewardRepository.save(retryReward);
      this.logger.warn(
        `Failed to send X posting reward to ${rewardEntry.address}, scheduled retry`,
      );
    }
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
    rewardEntry.next_retry_at =
      PROFILE_X_POSTING_REWARD_ENABLE_PERIODIC_RECHECKS
        ? new Date(Date.now() + this.getRetryDelaySeconds(retryCount) * 1000)
        : null;
  }

  private markRetryForXUserLookup(
    rewardEntry: ProfileXPostingReward,
    errorMessage: string,
  ): void {
    rewardEntry.retry_count = (rewardEntry.retry_count || 0) + 1;
    rewardEntry.status = 'pending';
    rewardEntry.error = errorMessage;
    rewardEntry.next_retry_at =
      PROFILE_X_POSTING_REWARD_ENABLE_PERIODIC_RECHECKS
        ? this.getNextScanTime()
        : null;
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

  private getNextManualRecheckTime(): Date | null {
    if (
      !this.isValidPositiveInteger(
        PROFILE_X_POSTING_REWARD_MANUAL_RECHECK_COOLDOWN_SECONDS,
      )
    ) {
      return null;
    }
    return new Date(
      Date.now() +
        PROFILE_X_POSTING_REWARD_MANUAL_RECHECK_COOLDOWN_SECONDS * 1000,
    );
  }

  private async claimPayoutAttempt(address: string): Promise<boolean> {
    const result = await this.postingRewardRepository.update(
      {
        address,
        tx_hash: IsNull(),
        status: In(['pending', 'failed']),
      } as any,
      {
        tx_hash: ProfileXPostingRewardService.PAYOUT_IN_PROGRESS_TX_HASH,
        error: null,
        next_retry_at: null,
        last_attempt_at: new Date(),
      },
    );
    return Number(result?.affected || 0) > 0;
  }

  private toPublicRewardStatus(
    reward: ProfileXPostingReward | null | undefined,
  ): PublicPostingRewardStatusPayload {
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
    const qualifiedCount = Number(reward.qualified_posts_count || 0);
    return {
      status:
        reward.status === 'blocked_x_identity_conflict'
          ? 'failed'
          : reward.status,
      x_username: reward.x_username,
      x_user_id: reward.x_user_id,
      qualified_posts_count: qualifiedCount,
      threshold: PROFILE_X_POSTING_REWARD_THRESHOLD,
      remaining_to_goal: Math.max(
        PROFILE_X_POSTING_REWARD_THRESHOLD - qualifiedCount,
        0,
      ),
      tx_hash:
        reward.tx_hash ===
        ProfileXPostingRewardService.PAYOUT_IN_PROGRESS_TX_HASH
          ? null
          : reward.tx_hash,
      retry_count: reward.retry_count || 0,
      next_retry_at:
        reward.tx_hash ===
        ProfileXPostingRewardService.PAYOUT_IN_PROGRESS_TX_HASH
          ? null
          : reward.next_retry_at,
      error: this.toPublicError(reward),
    };
  }

  private toPublicError(reward: ProfileXPostingReward): string | null {
    if (reward.status === 'paid') {
      return null;
    }
    if (
      reward.tx_hash === ProfileXPostingRewardService.PAYOUT_IN_PROGRESS_TX_HASH
    ) {
      return 'Reward payout is being finalized.';
    }
    switch (reward.error) {
      case 'missing_x_username':
        return 'Link your X account to use posting rewards.';
      case 'x_user_lookup_failed':
        return 'The linked X account could not be resolved. Reconnect it and try again.';
      case 'x_posts_fetch_failed':
        return 'X posts could not be checked right now. Try again later.';
      case 'x_posts_scan_truncated':
        return 'A portion of your posts was scanned. Recheck later for the rest.';
      case 'post_fetch_disabled':
        return 'Posting reward checks are temporarily unavailable.';
      case 'reward_wallet_not_configured':
      case 'invalid_threshold':
      case 'invalid_reward_amount':
      case 'invalid_scan_interval':
      case 'invalid_retry_base':
      case 'invalid_retry_max':
      case 'missing_keywords':
        return 'Posting rewards are temporarily unavailable.';
      case 'x_identity_already_rewarded':
      case 'x_identity_processing_elsewhere':
        return 'This X account is already being used for another reward.';
      case 'reward_amount_conversion_failed':
      case 'payout_send_failed':
        return 'Reward payout could not be completed right now. Try again later.';
      case 'payout_confirmation_pending':
        return 'Reward payout is being finalized.';
      default:
        return reward.error ? 'Posting reward is pending.' : null;
    }
  }

  private getOrderedXReadApiBaseUrls(): string[] {
    const preferred = this.preferredXReadBaseUrl;
    if (!preferred) {
      return [...ProfileXPostingRewardService.X_READ_API_BASE_URLS];
    }
    return [
      preferred,
      ...ProfileXPostingRewardService.X_READ_API_BASE_URLS.filter(
        (baseUrl) => baseUrl !== preferred,
      ),
    ];
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
      return null;
    }
  }

  private async fetchUserPostsSince(
    userId: string,
    sinceId?: string | null,
    startTime?: Date | null,
  ): Promise<XPostFetchResult | null> {
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
        return {
          posts: Array.from(postsById.values()),
          newestTweetId,
          truncated: true,
        };
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
        nextToken = (body as any)?.meta?.next_token
          ? String((body as any).meta.next_token)
          : null;
        const newestFromMeta = (body as any)?.meta?.newest_id
          ? String((body as any).meta.newest_id)
          : null;
        if (!nextToken) {
          newestTweetId = this.pickNewestTweetId(newestTweetId, newestFromMeta);
        }
        if (!nextToken) {
          return {
            posts: Array.from(postsById.values()),
            newestTweetId,
            truncated: false,
          };
        }
      } catch (error) {
        this.logger.warn(
          `Failed to fetch X posts for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
        );
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
      return this.xAppAccessTokenCache.token;
    }
    if (this.xAppTokenFetchBlockedUntilMs > Date.now()) {
      return null;
    }
    const appKey = X_API_KEY || X_CLIENT_ID;
    const appSecret = X_API_KEY_SECRET || X_CLIENT_SECRET;
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

    for (const baseUrl of this.getOrderedXReadApiBaseUrls()) {
      const endpoint = `${baseUrl}${pathAndQuery}`;
      const response = await this.fetchWithTimeout(endpoint, {
        headers: {
          Authorization: `Bearer ${String(bearerToken || '').trim()}`,
        },
      });
      const body = await response.json().catch(() => ({}));
      lastResponse = response;
      lastBody = body;
      lastBaseUrl = baseUrl;
      if (response.ok) {
        this.preferredXReadBaseUrl = baseUrl;
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

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private assertValidAddress(address: string): void {
    if (!ProfileXPostingRewardService.ADDRESS_REGEX.test(address || '')) {
      throw new BadRequestException('Invalid address');
    }
  }
}
