import { AeSdkService } from '@/ae/ae-sdk.service';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Name,
  MemoryAccount,
  Encoding,
  buildTxAsync,
  decode,
  isEncoded,
  sendTransaction,
  Tag,
  verifyMessageSignature,
} from '@aeternity/aepp-sdk';
import { randomBytes } from 'crypto';
import { DataSource, In, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import {
  ChainNameClaimStatus,
  ProfileChainNameClaim,
} from '../entities/profile-chain-name-claim.entity';
import { ProfileChainNameChallenge } from '../entities/profile-chain-name-challenge.entity';
import {
  PROFILE_CHAIN_NAME_CHALLENGE_TTL_SECONDS,
  PROFILE_CHAIN_NAME_MAX_RETRIES,
  PROFILE_CHAIN_NAME_PRIVATE_KEY,
  PROFILE_CHAIN_NAME_RETRY_BASE_SECONDS,
  PROFILE_CHAIN_NAME_RETRY_MAX_SECONDS,
} from '../profile.constants';
import { ProfileSpendQueueService } from './profile-spend-queue.service';

const RETRYABLE_STATUSES: ChainNameClaimStatus[] = [
  'pending',
  'preclaimed',
  'claimed',
];
const BATCH_SIZE = 50;
const MAX_PRECLAIM_AGE_BLOCKS = 250;

@Injectable()
export class ProfileChainNameService {
  private readonly logger = new Logger(ProfileChainNameService.name);
  private readonly processingByAddress = new Map<string, Promise<void>>();
  private isCronRunning = false;

  constructor(
    @InjectRepository(ProfileChainNameClaim)
    private readonly claimRepository: Repository<ProfileChainNameClaim>,
    @InjectRepository(ProfileChainNameChallenge)
    private readonly challengeRepository: Repository<ProfileChainNameChallenge>,
    private readonly dataSource: DataSource,
    private readonly aeSdkService: AeSdkService,
    private readonly profileSpendQueueService: ProfileSpendQueueService,
  ) {}

  async createChallenge(address: string): Promise<{
    nonce: string;
    expires_at: number;
    message: string;
  }> {
    this.assertValidAddress(address);

    const nonce = randomBytes(24).toString('hex');
    const expiresAt =
      Date.now() + PROFILE_CHAIN_NAME_CHALLENGE_TTL_SECONDS * 1000;
    const message = this.createChallengeMessage(address, nonce, expiresAt);

    await this.challengeRepository.save(
      this.challengeRepository.create({
        nonce,
        address,
        expires_at: new Date(expiresAt),
        consumed_at: null,
      }),
    );

    return {
      nonce,
      expires_at: expiresAt,
      message,
    };
  }

  async requestChainName(params: {
    address: string;
    name: string;
    challengeNonce: string;
    challengeExpiresAt: number;
    signatureHex: string;
  }): Promise<{ status: string; message: string }> {
    if (!PROFILE_CHAIN_NAME_PRIVATE_KEY) {
      this.logger.error(
        'PROFILE_CHAIN_NAME_PRIVATE_KEY is not configured, cannot process chain name claims',
      );
      throw new ServiceUnavailableException(
        'Chain name claiming is not available at this time',
      );
    }

    this.assertValidAddress(params.address);
    await this.verifyAndConsumeChallenge({
      address: params.address,
      nonce: params.challengeNonce,
      expiresAt: params.challengeExpiresAt,
      signatureHex: params.signatureHex,
    });

    const fullName = `${params.name}.chain`;
    const existing = await this.claimRepository.findOne({
      where: { address: params.address },
    });
    if (existing?.status === 'completed') {
      throw new ConflictException(
        `Address already has a claimed chain name: ${existing.name}`,
      );
    }
    if (existing && existing.status !== 'failed') {
      if (existing.name !== fullName) {
        throw new ConflictException(
          `Address already has an in-progress chain name claim: ${existing.name}`,
        );
      }
      void this.processClaimWithGuard(params.address);
      return {
        status: existing.status,
        message: `Chain name ${fullName} claim is already in progress for ${params.address}`,
      };
    }

    await this.assertSponsorHasFunds(fullName);

    const existingName = await this.claimRepository.findOne({
      where: { name: fullName },
    });
    if (
      existingName &&
      existingName.address !== params.address &&
      existingName.status !== 'failed'
    ) {
      throw new ConflictException(
        'This name is already being claimed by another address',
      );
    }
    const failedNameClaimToReplace =
      existingName &&
      existingName.address !== params.address &&
      existingName.status === 'failed'
        ? existingName
        : null;

    const onChainState = await this.getNameStateIfPresent(fullName);
    const sponsorAddress = this.getSponsorAccount().address;
    const ownedByThisFlow =
      existing?.address === params.address &&
      (onChainState?.owner === sponsorAddress ||
        onChainState?.owner === params.address);
    if (onChainState && !ownedByThisFlow) {
      throw new BadRequestException('This name is already taken on-chain');
    }

    const claim =
      existing ||
      this.claimRepository.create({
        address: params.address,
      });
    claim.name = fullName;
    claim.status = 'pending';
    claim.error = null;
    claim.retry_count = 0;
    claim.next_retry_at = new Date();
    claim.salt = null;
    claim.preclaim_height = null;
    claim.preclaim_tx_hash = null;
    claim.claim_tx_hash = null;
    claim.update_tx_hash = null;
    claim.transfer_tx_hash = null;

    try {
      if (failedNameClaimToReplace) {
        await this.claimRepository.delete({
          address: failedNameClaimToReplace.address,
        });
      }
      await this.claimRepository.save(claim);
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException(
          'This name is already being claimed by another address',
        );
      }
      throw error;
    }

    void this.processClaimWithGuard(params.address);

    return {
      status: 'ok',
      message: `Chain name ${fullName} claim started for ${params.address}`,
    };
  }

  async getClaimStatus(address: string): Promise<{
    status: ChainNameClaimStatus | 'not_started';
    name: string | null;
    preclaim_tx_hash: string | null;
    claim_tx_hash: string | null;
    update_tx_hash: string | null;
    transfer_tx_hash: string | null;
    error: string | null;
    retry_count: number;
  }> {
    this.assertValidAddress(address);

    const claim = await this.claimRepository.findOne({ where: { address } });
    if (!claim) {
      return {
        status: 'not_started',
        name: null,
        preclaim_tx_hash: null,
        claim_tx_hash: null,
        update_tx_hash: null,
        transfer_tx_hash: null,
        error: null,
        retry_count: 0,
      };
    }
    return {
      status: claim.status,
      name: claim.name,
      preclaim_tx_hash: claim.preclaim_tx_hash,
      claim_tx_hash: claim.claim_tx_hash,
      update_tx_hash: claim.update_tx_hash,
      transfer_tx_hash: claim.transfer_tx_hash,
      error: claim.error,
      retry_count: claim.retry_count,
    };
  }

  @Cron('*/30 * * * * *')
  async processDueClaims(): Promise<void> {
    if (this.isCronRunning) return;
    this.isCronRunning = true;
    try {
      const now = new Date();
      const dueClaims = await this.claimRepository.find({
        where: [
          { status: In(RETRYABLE_STATUSES), next_retry_at: IsNull() },
          {
            status: In(RETRYABLE_STATUSES),
            next_retry_at: LessThanOrEqual(now),
          },
        ],
        order: { next_retry_at: 'ASC', updated_at: 'ASC' },
        take: BATCH_SIZE,
      });
      for (const claim of dueClaims) {
        await this.processClaimWithGuard(claim.address);
      }
    } catch (error) {
      this.logger.error('Failed to process due chain name claims', error);
    } finally {
      this.isCronRunning = false;
    }
  }

  private async processClaimWithGuard(address: string): Promise<void> {
    const existing = this.processingByAddress.get(address);
    if (existing) return existing;

    const work = this.processClaimInternal(address).catch((error) => {
      this.logger.error(
        `Failed to process chain name claim for ${address}`,
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

  private async processClaimInternal(address: string): Promise<void> {
    const claim = await this.withLockedClaim(address, async (repo, entry) => {
      if (!entry || entry.status === 'completed' || entry.status === 'failed') {
        return null;
      }
      entry.last_attempt_at = new Date();
      await repo.save(entry);
      return entry;
    });
    if (!claim) return;

    switch (claim.status) {
      case 'pending':
        await this.stepPreclaim(address);
        break;
      case 'preclaimed':
        await this.stepClaim(address);
        break;
      case 'claimed':
        await this.stepUpdatePointer(address);
        break;
    }
  }

  private async stepPreclaim(address: string): Promise<void> {
    try {
      await this.profileSpendQueueService.enqueueSpend(
        PROFILE_CHAIN_NAME_PRIVATE_KEY,
        async () => {
          const claim = await this.claimRepository.findOne({
            where: { address },
          });
          if (!claim || claim.status !== 'pending') return;

          const nameInstance = this.createNameInstance(claim.name);
          const preclaimResult = await nameInstance.preclaim();

          await this.withLockedClaim(address, async (repo, entry) => {
            if (!entry || entry.status !== 'pending') return;
            entry.status = 'preclaimed';
            entry.salt = String(preclaimResult.nameSalt);
            entry.preclaim_tx_hash = preclaimResult.hash || null;
            entry.preclaim_height = preclaimResult.blockHeight ?? null;
            entry.error = null;
            entry.next_retry_at = new Date(Date.now() + 30_000);
            await repo.save(entry);
          });

          this.logger.log(
            `Preclaim submitted for ${claim.name} (${address}), tx: ${preclaimResult.hash}`,
          );
        },
      );
    } catch (error) {
      await this.markRetry(
        address,
        error instanceof Error ? error.message : String(error),
      );
      this.logger.warn(`Preclaim failed for ${address}, scheduled retry`);
    }
  }

  private async stepClaim(address: string): Promise<void> {
    try {
      const claim = await this.claimRepository.findOne({
        where: { address },
      });
      if (!claim || claim.status !== 'preclaimed' || !claim.salt) return;

      const sponsorAddress = this.getSponsorAccount().address;
      const onChainState = await this.getNameStateIfPresent(claim.name);
      if (onChainState?.owner === sponsorAddress) {
        await this.withLockedClaim(address, async (repo, entry) => {
          if (!entry || entry.status !== 'preclaimed') return;
          entry.status = 'claimed';
          entry.error = null;
          entry.next_retry_at = new Date();
          await repo.save(entry);
        });
        return;
      }
      if (onChainState?.owner === address) {
        await this.withLockedClaim(address, async (repo, entry) => {
          if (!entry || entry.status !== 'preclaimed') return;
          entry.status = 'completed';
          entry.error = null;
          entry.next_retry_at = null;
          await repo.save(entry);
        });
        return;
      }

      const currentHeight = await this.aeSdkService.sdk.getHeight();

      if (
        claim.preclaim_height != null &&
        currentHeight - claim.preclaim_height > MAX_PRECLAIM_AGE_BLOCKS
      ) {
        this.logger.warn(
          `Preclaim expired for ${claim.name} (${address}), resetting to pending`,
        );
        await this.withLockedClaim(address, async (repo, entry) => {
          if (!entry || entry.status !== 'preclaimed') return;
          entry.status = 'pending';
          entry.salt = null;
          entry.preclaim_height = null;
          entry.preclaim_tx_hash = null;
          entry.error = null;
          entry.retry_count = 0;
          entry.next_retry_at = new Date();
          await repo.save(entry);
        });
        return;
      }

      if (
        claim.preclaim_height != null &&
        currentHeight <= claim.preclaim_height
      ) {
        await this.withLockedClaim(address, async (repo, entry) => {
          if (!entry) return;
          entry.next_retry_at = new Date(Date.now() + 15_000);
          await repo.save(entry);
        });
        return;
      }

      await this.profileSpendQueueService.enqueueSpend(
        PROFILE_CHAIN_NAME_PRIVATE_KEY,
        async () => {
          const freshClaim = await this.claimRepository.findOne({
            where: { address },
          });
          if (
            !freshClaim ||
            freshClaim.status !== 'preclaimed' ||
            !freshClaim.salt
          ) {
            return;
          }

          const claimResult = await this.submitClaimTransaction(
            freshClaim.name,
            freshClaim.salt,
          );

          await this.withLockedClaim(address, async (repo, entry) => {
            if (!entry || entry.status !== 'preclaimed') return;
            entry.status = 'claimed';
            entry.claim_tx_hash = claimResult.hash || null;
            entry.error = null;
            entry.next_retry_at = new Date();
            await repo.save(entry);
          });

          this.logger.log(
            `Claim submitted for ${freshClaim.name} (${address}), tx: ${claimResult.hash}`,
          );
        },
      );
    } catch (error) {
      await this.markRetry(
        address,
        error instanceof Error ? error.message : String(error),
      );
      this.logger.warn(`Claim failed for ${address}, scheduled retry`);
    }
  }

  private async stepUpdatePointer(address: string): Promise<void> {
    try {
      const claim = await this.claimRepository.findOne({
        where: { address },
      });
      if (!claim || claim.status !== 'claimed') return;

      const sponsorAddress = this.getSponsorAccount().address;
      const onChainState = await this.getNameStateIfPresent(claim.name);
      if (onChainState?.owner === address) {
        await this.withLockedClaim(address, async (repo, entry) => {
          if (!entry || entry.status !== 'claimed') return;
          entry.status = 'completed';
          entry.error = null;
          entry.next_retry_at = null;
          await repo.save(entry);
        });
        return;
      }
      if (onChainState && onChainState.owner !== sponsorAddress) {
        throw new BadRequestException(
          `Chain name ${claim.name} is owned by an unexpected address`,
        );
      }

      await this.profileSpendQueueService.enqueueSpend(
        PROFILE_CHAIN_NAME_PRIVATE_KEY,
        async () => {
          const freshClaim = await this.claimRepository.findOne({
            where: { address },
          });
          if (!freshClaim || freshClaim.status !== 'claimed') return;

          const nameInstance = this.createNameInstance(freshClaim.name);
          const updateResult = await nameInstance.update({
            account_pubkey: address as `ak_${string}`,
          });
          const transferResult = await nameInstance.transfer(
            address as `ak_${string}`,
          );

          await this.withLockedClaim(address, async (repo, entry) => {
            if (!entry || entry.status !== 'claimed') return;
            entry.status = 'completed';
            entry.update_tx_hash = updateResult.hash || null;
            entry.transfer_tx_hash = transferResult.hash || null;
            entry.error = null;
            entry.next_retry_at = null;
            await repo.save(entry);
          });

          this.logger.log(
            `Pointer set and ownership transferred for ${freshClaim.name} -> ${address}, update tx: ${updateResult.hash}, transfer tx: ${transferResult.hash}`,
          );
        },
      );
    } catch (error) {
      await this.markRetry(
        address,
        error instanceof Error ? error.message : String(error),
      );
      this.logger.warn(`Pointer update failed for ${address}, scheduled retry`);
    }
  }

  private createNameInstance(chainName: string): Name {
    const sponsorAccount = this.getSponsorAccount();
    return new Name(chainName as `${string}.chain`, {
      ...this.aeSdkService.sdk.getContext(),
      onAccount: sponsorAccount,
    });
  }

  private getSponsorAccount(): MemoryAccount {
    return this.profileSpendQueueService.getRewardAccount(
      PROFILE_CHAIN_NAME_PRIVATE_KEY,
      'PROFILE_CHAIN_NAME_PRIVATE_KEY',
    );
  }

  private async submitClaimTransaction(chainName: string, salt: string) {
    const sponsorAccount = this.getSponsorAccount();
    const context = this.aeSdkService.sdk.getContext();
    const parsedSalt = Number(salt);

    if (!Number.isSafeInteger(parsedSalt) || parsedSalt < 0) {
      throw new Error(`Invalid persisted name salt for ${chainName}`);
    }

    const tx = await buildTxAsync({
      tag: Tag.NameClaimTx,
      onNode: context.onNode,
      onAccount: sponsorAccount,
      accountId: sponsorAccount.address,
      name: chainName as `${string}.chain`,
      nameSalt: parsedSalt,
    });
    return sendTransaction(tx, {
      onNode: context.onNode,
      onAccount: sponsorAccount,
    });
  }

  private async getNameStateIfPresent(fullName: string) {
    try {
      const nameObj = new Name(
        fullName as `${string}.chain`,
        this.aeSdkService.sdk.getContext(),
      );
      return await nameObj.getState();
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return null;
      }
      throw new ServiceUnavailableException(
        'Unable to verify chain name availability right now',
      );
    }
  }

  private async markRetry(
    address: string,
    errorMessage: string,
  ): Promise<void> {
    await this.withLockedClaim(address, async (repo, entry) => {
      if (!entry || entry.status === 'completed' || entry.status === 'failed') {
        return;
      }
      const retryCount = (entry.retry_count || 0) + 1;
      entry.retry_count = retryCount;
      entry.error = errorMessage;
      if (retryCount >= Math.max(PROFILE_CHAIN_NAME_MAX_RETRIES, 1)) {
        entry.status = 'failed';
        entry.next_retry_at = null;
      } else {
        entry.next_retry_at = new Date(
          Date.now() + this.getRetryDelayMs(retryCount),
        );
      }
      await repo.save(entry);
    });
  }

  private async verifyAndConsumeChallenge(params: {
    address: string;
    nonce: string;
    expiresAt: number;
    signatureHex: string;
  }): Promise<void> {
    if (!params.nonce || !params.signatureHex || !params.expiresAt) {
      throw new BadRequestException('Challenge proof is required');
    }
    const now = Date.now();
    if (params.expiresAt <= now) {
      throw new BadRequestException('Challenge has expired');
    }

    await this.dataSource.transaction(async (manager) => {
      const challengeRepo = manager.getRepository(ProfileChainNameChallenge);
      const challenge = await challengeRepo
        .createQueryBuilder('challenge')
        .setLock('pessimistic_write')
        .where('challenge.nonce = :nonce', { nonce: params.nonce })
        .andWhere('challenge.address = :address', { address: params.address })
        .andWhere('challenge.consumed_at IS NULL')
        .getOne();
      if (!challenge) {
        throw new BadRequestException('Challenge not found');
      }
      if (challenge.expires_at.getTime() !== params.expiresAt) {
        throw new BadRequestException('Challenge expiry mismatch');
      }
      if (challenge.expires_at.getTime() <= now) {
        throw new BadRequestException('Challenge has expired');
      }

      const message = this.createChallengeMessage(
        params.address,
        params.nonce,
        params.expiresAt,
      );
      if (
        !this.verifyAddressSignature(
          params.address,
          message,
          params.signatureHex,
        )
      ) {
        throw new BadRequestException('Invalid challenge signature');
      }

      challenge.consumed_at = new Date();
      await challengeRepo.save(challenge);
    });
  }

  private verifyAddressSignature(
    address: string,
    message: string,
    signatureHex: string,
  ): boolean {
    try {
      let signatureBytes: Uint8Array;
      if (signatureHex.startsWith('sg_')) {
        signatureBytes = Uint8Array.from(decode(signatureHex as any));
      } else {
        signatureBytes = Uint8Array.from(Buffer.from(signatureHex, 'hex'));
      }
      if (signatureBytes.length !== 64) {
        return false;
      }
      return verifyMessageSignature(
        message,
        signatureBytes,
        address as `ak_${string}`,
      );
    } catch {
      return false;
    }
  }

  private createChallengeMessage(
    address: string,
    nonce: string,
    expiresAt: number,
  ): string {
    return `profile_chain_name_claim:${address}:${nonce}:${expiresAt}`;
  }

  private assertValidAddress(address: string): void {
    if (!address || !isEncoded(address, Encoding.AccountAddress)) {
      throw new BadRequestException('Invalid address');
    }
  }

  private isNotFoundError(error: unknown): boolean {
    const status = Number(
      (error as any)?.statusCode ??
        (error as any)?.status ??
        (error as any)?.code,
    );
    const message = String(
      (error as any)?.message || (error as any)?.reason || '',
    ).toLowerCase();
    return (
      status === 404 ||
      message.includes('not found') ||
      message.includes('name not found')
    );
  }

  private isUniqueConstraintError(error: unknown): boolean {
    const driverError = (error as any)?.driverError || error;
    return String(driverError?.code || '') === '23505';
  }

  private async withLockedClaim<T>(
    address: string,
    work: (
      repo: Repository<ProfileChainNameClaim>,
      entry: ProfileChainNameClaim | null,
    ) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ProfileChainNameClaim);
      const entry = await repo
        .createQueryBuilder('claim')
        .setLock('pessimistic_write')
        .where('claim.address = :address', { address })
        .getOne();
      return work(repo, entry);
    });
  }

  private getRetryDelayMs(retryCount: number): number {
    const base = Math.max(PROFILE_CHAIN_NAME_RETRY_BASE_SECONDS, 1);
    const max = Math.max(PROFILE_CHAIN_NAME_RETRY_MAX_SECONDS, base);
    const exponent = Math.max(retryCount - 1, 0);
    const delay = base * 2 ** Math.min(exponent, 10);
    return Math.min(delay, max) * 1000;
  }
}
