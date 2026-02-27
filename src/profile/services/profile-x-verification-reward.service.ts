import { AeSdkService } from '@/ae/ae-sdk.service';
import { InjectRepository } from '@nestjs/typeorm';
import { toAettos } from '@aeternity/aepp-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import {
  PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE,
  PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY,
} from '../profile.constants';
import { ProfileXVerificationReward } from '../entities/profile-x-verification-reward.entity';
import { ProfileXInviteService } from './profile-x-invite.service';
import { ProfileSpendQueueService } from './profile-spend-queue.service';

@Injectable()
export class ProfileXVerificationRewardService {
  private readonly logger = new Logger(ProfileXVerificationRewardService.name);
  private static readonly ADDRESS_REGEX = /^ak_[1-9A-HJ-NP-Za-km-z]+$/;
  private readonly inFlightByAddress = new Map<string, Promise<void>>();
  private readonly inFlightByXUsername = new Map<string, Promise<void>>();

  constructor(
    @InjectRepository(ProfileXVerificationReward)
    private readonly rewardRepository: Repository<ProfileXVerificationReward>,
    private readonly aeSdkService: AeSdkService,
    private readonly profileXInviteService: ProfileXInviteService,
    private readonly profileSpendQueueService: ProfileSpendQueueService,
  ) {}

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

    const existingInFlight = this.inFlightByAddress.get(address);
    if (existingInFlight) {
      return existingInFlight;
    }
    const existingInFlightByX =
      this.inFlightByXUsername.get(normalizedXUsername);
    if (existingInFlightByX) {
      return existingInFlightByX;
    }
    const work = this.sendRewardIfEligibleInternal(
      address,
      normalizedXUsername,
    );
    this.inFlightByAddress.set(address, work);
    this.inFlightByXUsername.set(normalizedXUsername, work);
    try {
      await work;
    } finally {
      this.inFlightByAddress.delete(address);
      if (this.inFlightByXUsername.get(normalizedXUsername) === work) {
        this.inFlightByXUsername.delete(normalizedXUsername);
      }
    }
  }

  private async sendRewardIfEligibleInternal(
    address: string,
    xUsername: string,
  ): Promise<void> {
    if (!PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY) {
      this.logger.warn(
        'X verification reward is enabled but PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY is not configured',
      );
      return;
    }
    if (!ProfileXVerificationRewardService.ADDRESS_REGEX.test(address || '')) {
      this.logger.warn(
        `Skipping X verification reward, invalid account address: ${address}`,
      );
      return;
    }
    if (!this.isValidAeAmount(PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE)) {
      this.logger.error(
        `Skipping X verification reward, invalid PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE: ${PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE}`,
      );
      return;
    }
    const rewardAmountAettos = this.getRewardAmountAettos();
    if (!rewardAmountAettos) {
      return;
    }

    const [existingReward, existingRewardForX] =
      await Promise.all([
        this.rewardRepository.findOne({
          where: { address },
        }),
        this.rewardRepository.findOne({
          where: {
            x_username: xUsername,
            status: In(['paid', 'pending']),
          },
        }),
      ]);
    const existingPaidRewardForX =
      existingRewardForX?.status === 'paid' ? existingRewardForX : null;
    const existingPendingRewardForX =
      existingRewardForX?.status === 'pending' ? existingRewardForX : null;
    if (existingReward?.status === 'paid') {
      return;
    }
    if (existingPaidRewardForX && existingPaidRewardForX.address !== address) {
      this.logger.warn(
        `Skipping X verification reward for ${address}, X user ${xUsername} already rewarded on ${existingPaidRewardForX.address}`,
      );
      return;
    }
    if (
      existingPendingRewardForX &&
      existingPendingRewardForX.address !== address
    ) {
      this.logger.warn(
        `Skipping X verification reward for ${address}, X user ${xUsername} has pending reward on ${existingPendingRewardForX.address}`,
      );
      return;
    }

    const rewardEntry =
      existingReward ||
      this.rewardRepository.create({
        address,
        x_username: xUsername,
        status: 'pending',
      });

    if (existingReward) {
      rewardEntry.x_username = xUsername;
      rewardEntry.error = null;
      if (rewardEntry.status !== 'paid') {
        rewardEntry.status = 'pending';
      }
    }

    await this.rewardRepository.save(rewardEntry);

    await this.profileSpendQueueService.enqueueSpend(
      PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY,
      async () => {
      try {
        const rewardAccount = this.profileSpendQueueService.getRewardAccount(
          PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY,
          'PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY',
        );
        const spendResult = await this.aeSdkService.sdk.spend(
          rewardAmountAettos,
          address as `ak_${string}`,
          { onAccount: rewardAccount },
        );
        rewardEntry.tx_hash = spendResult.hash || null;
        rewardEntry.status = 'paid';
        rewardEntry.error = null;
        await this.rewardRepository.save(rewardEntry);
        void Promise.resolve(
          this.profileXInviteService.processInviteeXVerified(address),
        )
          .catch((error) =>
            this.logger.warn(
              `Failed to process invite X verification credit for ${address}: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        this.logger.log(
          `Sent ${PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE} AE X verification reward to ${address}`,
        );
      } catch (error: any) {
        rewardEntry.status = 'failed';
        rewardEntry.error =
          error instanceof Error
            ? error.message
            : String(error || 'Unknown error');
        await this.rewardRepository.save(rewardEntry);
        this.logger.error(
          `Failed to send X verification reward to ${address}`,
          error?.stack || error,
        );
        throw error;
      }
      },
    );
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

}
