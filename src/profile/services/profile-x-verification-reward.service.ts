import { AeSdkService } from '@/ae/ae-sdk.service';
import { InjectRepository } from '@nestjs/typeorm';
import { encode, Encoding, MemoryAccount, toAettos } from '@aeternity/aepp-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE,
  PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY,
} from '../profile.constants';
import { ProfileXVerificationReward } from '../entities/profile-x-verification-reward.entity';
import { parseProfilePrivateKeyBytes } from './profile-private-key.util';

@Injectable()
export class ProfileXVerificationRewardService {
  private readonly logger = new Logger(ProfileXVerificationRewardService.name);
  private readonly inFlightByAddress = new Map<string, Promise<void>>();
  private readonly inFlightByXUsername = new Map<string, Promise<void>>();
  private spendQueue: Promise<void> = Promise.resolve();
  private rewardAccount: MemoryAccount | null = null;
  private rewardAccountInitError: Error | null = null;

  constructor(
    @InjectRepository(ProfileXVerificationReward)
    private readonly rewardRepository: Repository<ProfileXVerificationReward>,
    private readonly aeSdkService: AeSdkService,
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
    if (!address.startsWith('ak_')) {
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

    const [existingReward, existingRewardForX] = await Promise.all([
      this.rewardRepository.findOne({
        where: { address },
      }),
      this.rewardRepository.findOne({
        where: { x_username: xUsername, status: 'paid' },
      }),
    ]);
    if (existingReward?.status === 'paid') {
      return;
    }
    if (existingRewardForX && existingRewardForX.address !== address) {
      this.logger.warn(
        `Skipping X verification reward for ${address}, X user ${xUsername} already rewarded on ${existingRewardForX.address}`,
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

    // Serialize all spends from the same backend account to avoid nonce conflicts.
    await this.enqueueSpend(async () => {
      try {
        const rewardAccount = this.getRewardAccount();
        const spendResult = await this.aeSdkService.sdk.spend(
          rewardAmountAettos,
          address as `ak_${string}`,
          { onAccount: rewardAccount },
        );
        rewardEntry.tx_hash = spendResult.hash || null;
        rewardEntry.status = 'paid';
        rewardEntry.error = null;
        await this.rewardRepository.save(rewardEntry);
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
      }
    });
  }

  private async enqueueSpend(work: () => Promise<void>): Promise<void> {
    const current = this.spendQueue.then(work, work);
    this.spendQueue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private getRewardAccount(): MemoryAccount {
    if (this.rewardAccount) {
      return this.rewardAccount;
    }
    if (this.rewardAccountInitError) {
      throw this.rewardAccountInitError;
    }
    try {
      this.rewardAccount = new MemoryAccount(
        this.normalizePrivateKey(PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY),
      );
      return this.rewardAccount;
    } catch (error) {
      this.rewardAccountInitError =
        error instanceof Error ? error : new Error(String(error));
      throw this.rewardAccountInitError;
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

  private normalizePrivateKey(privateKey: string): `sk_${string}` {
    try {
      const keyBytes = parseProfilePrivateKeyBytes(privateKey);
      const seed = keyBytes.length === 64 ? keyBytes.subarray(0, 32) : keyBytes;
      return encode(seed, Encoding.AccountSecretKey) as `sk_${string}`;
    } catch {
      throw new Error(
        'PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY must be a 32-byte seed or 64-byte secret key',
      );
    }
  }
}
