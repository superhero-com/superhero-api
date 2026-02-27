import { AeSdkService } from '@/ae/ae-sdk.service';
import { InjectRepository } from '@nestjs/typeorm';
import { toAettos } from '@aeternity/aepp-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  DataSource,
  In,
  IsNull,
  LessThanOrEqual,
  Not,
  Repository,
} from 'typeorm';
import {
  PROFILE_X_VERIFICATION_REWARD_FETCH_TIMEOUT_MS,
  PROFILE_X_VERIFICATION_REWARD_RETRY_BASE_SECONDS,
  PROFILE_X_VERIFICATION_REWARD_RETRY_MAX_SECONDS,
  PROFILE_X_VERIFICATION_MIN_FOLLOWERS,
  PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE,
  PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY,
} from '../profile.constants';
import { ProfileXVerificationReward } from '../entities/profile-x-verification-reward.entity';
import { ProfileXInviteService } from './profile-x-invite.service';
import { ProfileSpendQueueService } from './profile-spend-queue.service';
import { X_CLIENT_ID, X_CLIENT_SECRET } from '@/configs/social';

@Injectable()
export class ProfileXVerificationRewardService {
  private readonly logger = new Logger(ProfileXVerificationRewardService.name);
  private static readonly ADDRESS_REGEX = /^ak_[1-9A-HJ-NP-Za-km-z]+$/;
  private static readonly RETRYABLE_STATUSES: Array<
    ProfileXVerificationReward['status']
  > = ['pending', 'failed'];
  private static readonly DEFAULT_X_APP_TOKEN_TTL_SECONDS = 3600;
  private static readonly DEFAULT_RETRY_BATCH_SIZE = 100;
  private xAppAccessTokenCache: { token: string; expiresAtMs: number } | null =
    null;
  private readonly processingByAddress = new Map<string, Promise<void>>();
  private isRetryWorkerRunning = false;

  constructor(
    @InjectRepository(ProfileXVerificationReward)
    private readonly rewardRepository: Repository<ProfileXVerificationReward>,
    private readonly dataSource: DataSource,
    private readonly aeSdkService: AeSdkService,
    private readonly profileXInviteService: ProfileXInviteService,
    private readonly profileSpendQueueService: ProfileSpendQueueService,
  ) {}

  @Cron('*/30 * * * * *')
  async processDueRewards(): Promise<void> {
    if (this.isRetryWorkerRunning) {
      return;
    }
    this.isRetryWorkerRunning = true;
    try {
      const now = new Date();
      const dueRewards = await this.rewardRepository.find({
        where: [
          {
            status: In(ProfileXVerificationRewardService.RETRYABLE_STATUSES),
            next_retry_at: IsNull(),
          },
          {
            status: In(ProfileXVerificationRewardService.RETRYABLE_STATUSES),
            next_retry_at: LessThanOrEqual(now),
          },
        ],
        order: {
          next_retry_at: 'ASC',
          updated_at: 'ASC',
        },
        take: ProfileXVerificationRewardService.DEFAULT_RETRY_BATCH_SIZE,
      });
      for (const reward of dueRewards) {
        await this.processAddressWithGuard(reward.address);
      }
    } catch (error) {
      this.logger.error('Failed to process due X verification rewards', error);
    } finally {
      this.isRetryWorkerRunning = false;
    }
  }

  async sendRewardIfEligible(
    address: string,
    xUsername: string,
  ): Promise<void> {
    const normalizedXUsername = this.normalizeXUsername(xUsername);
    if (!normalizedXUsername) {
      this.logger.warn(
        `Skipping X verification reward, invalid x username: ${xUsername}`,
      );
      return;
    }
    if (!ProfileXVerificationRewardService.ADDRESS_REGEX.test(address || '')) {
      this.logger.warn(
        `Skipping X verification reward, invalid account address: ${address}`,
      );
      return;
    }
    const existingReward = await this.rewardRepository.findOne({
      where: { address },
    });
    if (existingReward?.status === 'paid') {
      return;
    }
    const rewardEntry =
      existingReward ||
      this.rewardRepository.create({
        address,
      });
    rewardEntry.x_username = normalizedXUsername;
    rewardEntry.status = 'pending';
    rewardEntry.error = null;
    rewardEntry.next_retry_at = new Date();
    await this.rewardRepository.save(rewardEntry);
    await this.processAddressWithGuard(address);
  }

  private async processAddressWithGuard(address: string): Promise<void> {
    const existingInFlight = this.processingByAddress.get(address);
    if (existingInFlight) {
      return existingInFlight;
    }
    const work = this.processAddressInternal(address).catch((error) => {
      this.logger.error(
        `Failed to process X verification reward for ${address}`,
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
      const amount = toAettos(PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE);
      if (!/^\d+$/.test(amount) || amount === '0') {
        this.logger.error(
          `Skipping X verification reward, converted aettos amount is invalid: ${amount}`,
        );
        return null;
      }
      return amount;
    } catch (error) {
      this.logger.error(
        'Skipping X verification reward, failed to convert amount to aettos',
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  private async fetchXFollowersCount(
    xUsername: string,
  ): Promise<number | null> {
    const token = await this.getXAppAccessToken();
    if (!token) {
      return null;
    }
    const endpoint = `https://api.x.com/2/users/by/username/${encodeURIComponent(xUsername)}?user.fields=public_metrics`;
    try {
      const response = await this.fetchWithTimeout(endpoint, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.logger.warn(
          'X user lookup failed while checking reward eligibility',
          {
            x_username: xUsername,
            status: response.status,
            detail: (body as any)?.detail,
          },
        );
        return null;
      }
      const followersCount = (body as any)?.data?.public_metrics
        ?.followers_count;
      if (!Number.isInteger(followersCount) || followersCount < 0) {
        this.logger.warn(
          `X user lookup returned invalid followers_count for @${xUsername}`,
        );
        return null;
      }
      return followersCount;
    } catch (error) {
      this.logger.warn(
        `Failed to fetch followers_count for @${xUsername}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async getXAppAccessToken(): Promise<string | null> {
    if (
      this.xAppAccessTokenCache &&
      this.xAppAccessTokenCache.expiresAtMs > Date.now()
    ) {
      return this.xAppAccessTokenCache.token;
    }
    if (!X_CLIENT_ID || !X_CLIENT_SECRET) {
      this.logger.warn(
        'Skipping X verification reward, X_CLIENT_ID/X_CLIENT_SECRET are required to verify followers count',
      );
      return null;
    }
    try {
      const basicAuth = Buffer.from(
        `${X_CLIENT_ID}:${X_CLIENT_SECRET}`,
        'utf-8',
      ).toString('base64');
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: X_CLIENT_ID,
      });
      const response = await this.fetchWithTimeout(
        'https://api.x.com/2/oauth2/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basicAuth}`,
          },
          body: body.toString(),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !(payload as any)?.access_token) {
        this.logger.warn(
          'Failed to obtain X app access token for reward checks',
          {
            status: response.status,
            error: (payload as any)?.error,
            error_description: (payload as any)?.error_description,
          },
        );
        return null;
      }
      const expiresInSeconds = Number((payload as any).expires_in);
      const ttlSeconds =
        Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
          ? expiresInSeconds
          : ProfileXVerificationRewardService.DEFAULT_X_APP_TOKEN_TTL_SECONDS;
      this.xAppAccessTokenCache = {
        token: (payload as any).access_token,
        expiresAtMs: Date.now() + Math.max(ttlSeconds - 60, 30) * 1000,
      };
      return this.xAppAccessTokenCache.token;
    } catch (error) {
      this.logger.warn(
        `Failed to obtain X app access token for reward checks: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async processAddressInternal(address: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const rewardRepo = manager.getRepository(ProfileXVerificationReward);
      const rewardEntry = await rewardRepo
        .createQueryBuilder('reward')
        .setLock('pessimistic_write')
        .where('reward.address = :address', { address })
        .getOne();
      if (!rewardEntry) {
        return;
      }
      if (rewardEntry.status === 'paid') {
        return;
      }
      if (rewardEntry.status === 'ineligible_followers') {
        return;
      }
      if (rewardEntry.status === 'blocked_username_conflict') {
        return;
      }

      rewardEntry.last_attempt_at = new Date();
      const normalizedXUsername = this.normalizeXUsername(
        rewardEntry.x_username || '',
      );
      if (!normalizedXUsername) {
        this.markRetry(
          rewardEntry,
          'Reward row has no valid X username yet',
          'pending',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }
      rewardEntry.x_username = normalizedXUsername;

      if (!this.isValidAeAmount(PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE)) {
        this.markRetry(
          rewardEntry,
          `Invalid PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE: ${PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE}`,
          'failed',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }
      if (!this.isValidPositiveInteger(PROFILE_X_VERIFICATION_MIN_FOLLOWERS)) {
        this.markRetry(
          rewardEntry,
          `Invalid PROFILE_X_VERIFICATION_MIN_FOLLOWERS: ${PROFILE_X_VERIFICATION_MIN_FOLLOWERS}`,
          'failed',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }
      if (
        !this.isValidPositiveInteger(
          PROFILE_X_VERIFICATION_REWARD_RETRY_BASE_SECONDS,
        )
      ) {
        this.markRetry(
          rewardEntry,
          `Invalid PROFILE_X_VERIFICATION_REWARD_RETRY_BASE_SECONDS: ${PROFILE_X_VERIFICATION_REWARD_RETRY_BASE_SECONDS}`,
          'failed',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }
      if (
        !this.isValidPositiveInteger(
          PROFILE_X_VERIFICATION_REWARD_RETRY_MAX_SECONDS,
        )
      ) {
        this.markRetry(
          rewardEntry,
          `Invalid PROFILE_X_VERIFICATION_REWARD_RETRY_MAX_SECONDS: ${PROFILE_X_VERIFICATION_REWARD_RETRY_MAX_SECONDS}`,
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
        !ProfileXVerificationRewardService.ADDRESS_REGEX.test(
          rewardEntry.address || '',
        )
      ) {
        this.markRetry(rewardEntry, 'Reward row has invalid address', 'failed');
        await rewardRepo.save(rewardEntry);
        return;
      }

      const existingRewardForX = await rewardRepo.findOne({
        where: {
          x_username: normalizedXUsername,
          status: In(['paid', 'pending']),
          address: Not(rewardEntry.address),
        },
      });
      if (existingRewardForX?.status === 'paid') {
        rewardEntry.status = 'blocked_username_conflict';
        rewardEntry.error = `X user @${normalizedXUsername} already rewarded on ${existingRewardForX.address}`;
        rewardEntry.next_retry_at = null;
        await rewardRepo.save(rewardEntry);
        return;
      }
      if (existingRewardForX?.status === 'pending') {
        this.markRetry(
          rewardEntry,
          `X user @${normalizedXUsername} has active reward processing on ${existingRewardForX.address}`,
          'pending',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }

      const followersCount =
        await this.fetchXFollowersCount(normalizedXUsername);
      if (followersCount === null) {
        this.markRetry(
          rewardEntry,
          `Unable to verify followers count for @${normalizedXUsername}`,
          'pending',
        );
        await rewardRepo.save(rewardEntry);
        return;
      }
      if (followersCount < PROFILE_X_VERIFICATION_MIN_FOLLOWERS) {
        rewardEntry.status = 'ineligible_followers';
        rewardEntry.error = `@${normalizedXUsername} has ${followersCount} followers (minimum ${PROFILE_X_VERIFICATION_MIN_FOLLOWERS})`;
        rewardEntry.next_retry_at = null;
        await rewardRepo.save(rewardEntry);
        this.logger.log(
          `Skipping X verification reward for ${rewardEntry.address}, @${normalizedXUsername} has ${followersCount} followers (minimum ${PROFILE_X_VERIFICATION_MIN_FOLLOWERS})`,
        );
        return;
      }

      const rewardAmountAettos = this.getRewardAmountAettos();
      if (!rewardAmountAettos) {
        this.markRetry(
          rewardEntry,
          'Failed to convert reward amount to aettos',
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
            void Promise.resolve(
              this.profileXInviteService.processInviteeXVerified(address),
            ).catch((error) =>
              this.logger.warn(
                `Failed to process invite X verification credit for ${address}: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
            this.logger.log(
              `Sent ${PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE} AE X verification reward to ${address}`,
            );
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
          `Failed to send X verification reward to ${address}, scheduled retry`,
        );
      }
    });
  }

  private markRetry(
    rewardEntry: ProfileXVerificationReward,
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

  private getRetryDelaySeconds(retryCount: number): number {
    const base = Math.max(PROFILE_X_VERIFICATION_REWARD_RETRY_BASE_SECONDS, 1);
    const max = Math.max(PROFILE_X_VERIFICATION_REWARD_RETRY_MAX_SECONDS, base);
    const exponent = Math.max(retryCount - 1, 0);
    const delay = base * 2 ** Math.min(exponent, 10);
    return Math.min(delay, max);
  }

  private async fetchWithTimeout(
    input: string,
    init?: RequestInit,
  ): Promise<Response> {
    const timeoutMs = this.isValidPositiveInteger(
      PROFILE_X_VERIFICATION_REWARD_FETCH_TIMEOUT_MS,
    )
      ? PROFILE_X_VERIFICATION_REWARD_FETCH_TIMEOUT_MS
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
}
