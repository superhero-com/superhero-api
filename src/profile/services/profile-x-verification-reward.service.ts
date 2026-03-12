import { AeSdkService } from '@/ae/ae-sdk.service';
import { InjectRepository } from '@nestjs/typeorm';
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
import { ProfileXApiClientService } from './profile-x-api-client.service';
import { ProfileSpendQueueService } from './profile-spend-queue.service';
import {
  getRewardAmountAettos,
  isValidAeAmount,
  isValidPositiveInteger,
  normalizeXUsername,
  processAddressWithGuard,
} from './profile-x-reward.util';
import {
  X_CLIENT_ID,
  X_CLIENT_SCOPE,
  X_CLIENT_SECRET,
  X_CLIENT_TYPE,
} from '@/configs/social';

type XFollowersLookupResult =
  | { kind: 'ok'; followersCount: number }
  | { kind: 'retry'; error: string }
  | { kind: 'terminal'; error: string };

@Injectable()
export class ProfileXVerificationRewardService {
  private readonly logger = new Logger(ProfileXVerificationRewardService.name);
  private static readonly ADDRESS_REGEX = /^ak_[1-9A-HJ-NP-Za-km-z]+$/;
  private static readonly RETRYABLE_STATUSES: Array<
    ProfileXVerificationReward['status']
  > = ['pending', 'failed'];
  private static readonly DEFAULT_RETRY_BATCH_SIZE = 100;
  private readonly processingByAddress = new Map<string, Promise<void>>();
  private isRetryWorkerRunning = false;

  constructor(
    @InjectRepository(ProfileXVerificationReward)
    private readonly rewardRepository: Repository<ProfileXVerificationReward>,
    private readonly dataSource: DataSource,
    private readonly aeSdkService: AeSdkService,
    private readonly profileXInviteService: ProfileXInviteService,
    private readonly profileSpendQueueService: ProfileSpendQueueService,
    private readonly profileXApiClientService: ProfileXApiClientService,
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
            status: 'pending',
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
    const normalizedXUsername = normalizeXUsername(xUsername);
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

  async getRewardStatus(address: string): Promise<{
    status: ProfileXVerificationReward['status'] | 'not_started';
    x_username: string | null;
    tx_hash: string | null;
    retry_count: number;
    next_retry_at: Date | null;
    error: string | null;
  }> {
    const reward = await this.rewardRepository.findOne({
      where: { address },
    });
    if (!reward) {
      return {
        status: 'not_started',
        x_username: null,
        tx_hash: null,
        retry_count: 0,
        next_retry_at: null,
        error: null,
      };
    }
    return {
      status: reward.status,
      x_username: reward.x_username,
      tx_hash: reward.tx_hash,
      retry_count: reward.retry_count || 0,
      next_retry_at: reward.next_retry_at,
      error: reward.error,
    };
  }

  private async processAddressWithGuard(address: string): Promise<void> {
    await processAddressWithGuard({
      address,
      processingByAddress: this.processingByAddress,
      workFactory: () => this.processAddressInternal(address),
      logger: this.logger,
      errorMessage: `Failed to process X verification reward for ${address}`,
    });
  }

  private getRewardAmountAettos(): string | null {
    return getRewardAmountAettos({
      amountAe: PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE,
      logger: this.logger,
      rewardLabel: 'X verification reward',
    });
  }

  private async fetchXFollowersCount(
    xUsername: string,
  ): Promise<XFollowersLookupResult> {
    const token = await this.getXAppAccessToken();
    if (!token) {
      return {
        kind: 'retry',
        error: `Unable to obtain X app token while checking @${xUsername}`,
      };
    }
    try {
      const { response, body, baseUrl } = await this.fetchXReadWithAuthFallback(
        `/2/users/by/username/${encodeURIComponent(xUsername)}?user.fields=public_metrics`,
        token,
      );
      if (!response.ok) {
        this.logger.warn(
          'X user lookup failed while checking reward eligibility',
          {
            x_username: xUsername,
            base_url: baseUrl,
            status: response.status,
            detail: (body as any)?.detail,
          },
        );
        const detail =
          this.extractXApiErrorDetail(body) ||
          `HTTP ${response.status} from ${baseUrl}`;
        if (this.isTerminalXLookupError(response.status, body)) {
          return {
            kind: 'terminal',
            error: `X user lookup failed permanently for @${xUsername}: ${detail}`,
          };
        }
        return {
          kind: 'retry',
          error: `Unable to verify followers count for @${xUsername}: ${detail}`,
        };
      }
      const followersCount = (body as any)?.data?.public_metrics
        ?.followers_count;
      if (!Number.isInteger(followersCount) || followersCount < 0) {
        this.logger.warn(
          `X user lookup returned invalid followers_count for @${xUsername}`,
        );
        return {
          kind: 'retry',
          error: `X user lookup returned invalid followers_count for @${xUsername}`,
        };
      }
      return {
        kind: 'ok',
        followersCount,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to fetch followers_count for @${xUsername}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        kind: 'retry',
        error: `Unable to verify followers count for @${xUsername}`,
      };
    }
  }

  private async getXAppAccessToken(): Promise<string | null> {
    const timeoutMs = isValidPositiveInteger(
      PROFILE_X_VERIFICATION_REWARD_FETCH_TIMEOUT_MS,
    )
      ? PROFILE_X_VERIFICATION_REWARD_FETCH_TIMEOUT_MS
      : 5000;
    return this.profileXApiClientService.getXAppAccessToken({
      appKey: X_CLIENT_ID,
      appSecret: X_CLIENT_SECRET,
      tokenEndpoints: [
        {
          baseUrl: 'https://api.x.com',
          url: 'https://api.x.com/2/oauth2/token',
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: X_CLIENT_ID,
            client_secret: X_CLIENT_SECRET,
            client_type: X_CLIENT_TYPE,
            scope: X_CLIENT_SCOPE,
          }),
        },
        {
          baseUrl: 'https://api.twitter.com',
          url: 'https://api.twitter.com/oauth2/token',
          body: new URLSearchParams({
            grant_type: 'client_credentials',
          }),
        },
      ],
      logger: this.logger,
      missingCredentialsMessage:
        'Skipping X verification reward, X_CLIENT_ID/X_CLIENT_SECRET are required to verify followers count',
      tokenFailureMessage:
        'Failed to obtain X app access token for reward checks',
      tokenErrorPrefix: 'Failed to obtain X app access token for reward checks',
      timeoutMs,
    });
  }

  private async processAddressInternal(address: string): Promise<void> {
    const preparedReward = await this.dataSource.transaction(
      async (manager) => {
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
          return null;
        }

        rewardEntry.last_attempt_at = new Date();
        const normalizedXUsername = normalizeXUsername(
          rewardEntry.x_username || '',
        );
        if (!normalizedXUsername) {
          this.markRetry(
            rewardEntry,
            'Reward row has no valid X username yet',
            'pending',
          );
          await rewardRepo.save(rewardEntry);
          return null;
        }
        rewardEntry.x_username = normalizedXUsername;

        if (!isValidAeAmount(PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE)) {
          this.markRetry(
            rewardEntry,
            `Invalid PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE: ${PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE}`,
            'failed',
          );
          await rewardRepo.save(rewardEntry);
          return null;
        }
        if (!isValidPositiveInteger(PROFILE_X_VERIFICATION_MIN_FOLLOWERS)) {
          this.markRetry(
            rewardEntry,
            `Invalid PROFILE_X_VERIFICATION_MIN_FOLLOWERS: ${PROFILE_X_VERIFICATION_MIN_FOLLOWERS}`,
            'failed',
          );
          await rewardRepo.save(rewardEntry);
          return null;
        }
        if (
          !isValidPositiveInteger(
            PROFILE_X_VERIFICATION_REWARD_RETRY_BASE_SECONDS,
          )
        ) {
          this.markRetry(
            rewardEntry,
            `Invalid PROFILE_X_VERIFICATION_REWARD_RETRY_BASE_SECONDS: ${PROFILE_X_VERIFICATION_REWARD_RETRY_BASE_SECONDS}`,
            'failed',
          );
          await rewardRepo.save(rewardEntry);
          return null;
        }
        if (
          !isValidPositiveInteger(
            PROFILE_X_VERIFICATION_REWARD_RETRY_MAX_SECONDS,
          )
        ) {
          this.markRetry(
            rewardEntry,
            `Invalid PROFILE_X_VERIFICATION_REWARD_RETRY_MAX_SECONDS: ${PROFILE_X_VERIFICATION_REWARD_RETRY_MAX_SECONDS}`,
            'failed',
          );
          await rewardRepo.save(rewardEntry);
          return null;
        }
        if (!PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY) {
          this.markRetry(
            rewardEntry,
            'PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY is not configured',
            'failed',
          );
          await rewardRepo.save(rewardEntry);
          return null;
        }
        if (
          !ProfileXVerificationRewardService.ADDRESS_REGEX.test(
            rewardEntry.address || '',
          )
        ) {
          this.markRetry(
            rewardEntry,
            'Reward row has invalid address',
            'failed',
          );
          await rewardRepo.save(rewardEntry);
          return null;
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
          return null;
        }
        if (existingRewardForX?.status === 'pending') {
          this.markRetry(
            rewardEntry,
            `X user @${normalizedXUsername} has active reward processing on ${existingRewardForX.address}`,
            'pending',
          );
          await rewardRepo.save(rewardEntry);
          return null;
        }

        const rewardAmountAettos = this.getRewardAmountAettos();
        if (!rewardAmountAettos) {
          this.markRetry(
            rewardEntry,
            'Failed to convert reward amount to aettos',
            'failed',
          );
          await rewardRepo.save(rewardEntry);
          return null;
        }

        await rewardRepo.save(rewardEntry);
        return {
          normalizedXUsername,
          rewardAmountAettos,
        };
      },
    );
    if (!preparedReward) {
      return;
    }

    const followersLookup = await this.fetchXFollowersCount(
      preparedReward.normalizedXUsername,
    );
    if (followersLookup.kind === 'retry') {
      await this.withLockedRewardEntry(
        address,
        async (rewardRepo, rewardEntry) => {
          this.markRetry(rewardEntry, followersLookup.error, 'pending');
          await rewardRepo.save(rewardEntry);
        },
      );
      return;
    }
    if (followersLookup.kind === 'terminal') {
      await this.withLockedRewardEntry(
        address,
        async (rewardRepo, rewardEntry) => {
          this.markTerminalFailure(rewardEntry, followersLookup.error);
          await rewardRepo.save(rewardEntry);
        },
      );
      return;
    }
    if (followersLookup.followersCount < PROFILE_X_VERIFICATION_MIN_FOLLOWERS) {
      await this.withLockedRewardEntry(
        address,
        async (rewardRepo, rewardEntry) => {
          rewardEntry.status = 'ineligible_followers';
          rewardEntry.error = `@${preparedReward.normalizedXUsername} has ${followersLookup.followersCount} followers (minimum ${PROFILE_X_VERIFICATION_MIN_FOLLOWERS})`;
          rewardEntry.next_retry_at = null;
          await rewardRepo.save(rewardEntry);
        },
      );
      this.logger.log(
        `Skipping X verification reward for ${address}, @${preparedReward.normalizedXUsername} has ${followersLookup.followersCount} followers (minimum ${PROFILE_X_VERIFICATION_MIN_FOLLOWERS})`,
      );
      return;
    }

    const shouldSpend = await this.dataSource.transaction(async (manager) => {
      const rewardRepo = manager.getRepository(ProfileXVerificationReward);
      const rewardEntry = await rewardRepo
        .createQueryBuilder('reward')
        .setLock('pessimistic_write')
        .where('reward.address = :address', { address })
        .getOne();
      if (!rewardEntry || this.isTerminalRewardStatus(rewardEntry.status)) {
        return false;
      }
      const existingRewardForX = await rewardRepo.findOne({
        where: {
          x_username: preparedReward.normalizedXUsername,
          status: In(['paid', 'pending']),
          address: Not(address),
        },
      });
      if (existingRewardForX?.status === 'paid') {
        rewardEntry.status = 'blocked_username_conflict';
        rewardEntry.error = `X user @${preparedReward.normalizedXUsername} already rewarded on ${existingRewardForX.address}`;
        rewardEntry.next_retry_at = null;
        await rewardRepo.save(rewardEntry);
        return false;
      }
      if (existingRewardForX?.status === 'pending') {
        this.markRetry(
          rewardEntry,
          `X user @${preparedReward.normalizedXUsername} has active reward processing on ${existingRewardForX.address}`,
          'pending',
        );
        await rewardRepo.save(rewardEntry);
        return false;
      }
      return true;
    });
    if (!shouldSpend) {
      return;
    }

    try {
      await this.profileSpendQueueService.enqueueSpend(
        PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY,
        async () => {
          const rewardAccount = this.profileSpendQueueService.getRewardAccount(
            PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY,
            'PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY',
          );
          const spendResult = await this.aeSdkService.sdk.spend(
            preparedReward.rewardAmountAettos,
            address as `ak_${string}`,
            { onAccount: rewardAccount },
          );
          await this.withLockedRewardEntry(
            address,
            async (rewardRepo, rewardEntry) => {
              rewardEntry.tx_hash = spendResult.hash || null;
              rewardEntry.status = 'paid';
              rewardEntry.error = null;
              rewardEntry.next_retry_at = null;
              await rewardRepo.save(rewardEntry);
            },
          );
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
      await this.withLockedRewardEntry(
        address,
        async (rewardRepo, rewardEntry) => {
          this.markRetry(
            rewardEntry,
            error instanceof Error
              ? error.message
              : String(error || 'Unknown error'),
            'pending',
          );
          await rewardRepo.save(rewardEntry);
        },
      );
      this.logger.warn(
        `Failed to send X verification reward to ${address}, scheduled retry`,
      );
    }
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

  private markTerminalFailure(
    rewardEntry: ProfileXVerificationReward,
    errorMessage: string,
  ): void {
    rewardEntry.status = 'failed';
    rewardEntry.error = errorMessage;
    rewardEntry.next_retry_at = null;
  }

  private isTerminalRewardStatus(
    status: ProfileXVerificationReward['status'],
  ): boolean {
    return (
      status === 'paid' ||
      status === 'ineligible_followers' ||
      status === 'blocked_username_conflict'
    );
  }

  private async withLockedRewardEntry(
    address: string,
    work: (
      rewardRepo: Repository<ProfileXVerificationReward>,
      rewardEntry: ProfileXVerificationReward,
    ) => Promise<void>,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const rewardRepo = manager.getRepository(ProfileXVerificationReward);
      const rewardEntry = await rewardRepo
        .createQueryBuilder('reward')
        .setLock('pessimistic_write')
        .where('reward.address = :address', { address })
        .getOne();
      if (!rewardEntry || this.isTerminalRewardStatus(rewardEntry.status)) {
        return;
      }
      await work(rewardRepo, rewardEntry);
    });
  }

  private getRetryDelaySeconds(retryCount: number): number {
    const base = Math.max(PROFILE_X_VERIFICATION_REWARD_RETRY_BASE_SECONDS, 1);
    const max = Math.max(PROFILE_X_VERIFICATION_REWARD_RETRY_MAX_SECONDS, base);
    const exponent = Math.max(retryCount - 1, 0);
    const delay = base * 2 ** Math.min(exponent, 10);
    return Math.min(delay, max);
  }

  private async fetchXReadWithAuthFallback(
    pathAndQuery: string,
    bearerToken: string,
  ): Promise<{ response: Response; body: any; baseUrl: string }> {
    const timeoutMs = isValidPositiveInteger(
      PROFILE_X_VERIFICATION_REWARD_FETCH_TIMEOUT_MS,
    )
      ? PROFILE_X_VERIFICATION_REWARD_FETCH_TIMEOUT_MS
      : 5000;
    return this.profileXApiClientService.fetchXReadWithAuthFallback(
      pathAndQuery,
      bearerToken,
      timeoutMs,
      'profile-x-read',
    );
  }

  private isTerminalXLookupError(status: number, body: any): boolean {
    if (status === 404) {
      return true;
    }
    if (status === 400) {
      return true;
    }
    const detail = this.extractXApiErrorDetail(body)?.toLowerCase() || '';
    return (
      detail.includes('resource-not-found') ||
      detail.includes('could not find user') ||
      detail.includes('user not found')
    );
  }

  private extractXApiErrorDetail(body: any): string | null {
    return this.profileXApiClientService.extractXApiErrorDetail(body);
  }
}
