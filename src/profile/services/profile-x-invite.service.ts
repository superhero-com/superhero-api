import { AeSdkService } from '@/ae/ae-sdk.service';
import { InjectRepository } from '@nestjs/typeorm';
import { decode, toAettos, verifyMessageSignature } from '@aeternity/aepp-sdk';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import {
  PROFILE_X_INVITE_CHALLENGE_TTL_SECONDS,
  PROFILE_X_INVITE_LINK_BASE_URL,
  PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE,
  PROFILE_X_INVITE_MILESTONE_REWARD_PRIVATE_KEY,
  PROFILE_X_INVITE_MILESTONE_THRESHOLD,
  PROFILE_X_INVITE_PENDING_TIMEOUT_SECONDS,
} from '../profile.constants';
import { ProfileXInviteChallenge } from '../entities/profile-x-invite-challenge.entity';
import { ProfileXInvite } from '../entities/profile-x-invite.entity';
import { ProfileXInviteCredit } from '../entities/profile-x-invite-credit.entity';
import { ProfileXInviteMilestoneReward } from '../entities/profile-x-invite-milestone-reward.entity';
import { ProfileSpendQueueService } from './profile-spend-queue.service';

type InviteProgress = {
  inviter_address: string;
  verified_friends_count: number;
  goal: number;
  remaining_to_goal: number;
  milestone_reward_status: 'not_started' | 'pending' | 'paid' | 'failed';
  milestone_reward_tx_hash: string | null;
};

@Injectable()
export class ProfileXInviteService {
  private readonly logger = new Logger(ProfileXInviteService.name);
  private static readonly ADDRESS_REGEX = /^ak_[1-9A-HJ-NP-Za-km-z]+$/;
  private static readonly CODE_REGEX = /^[a-z0-9]{12}$/;

  constructor(
    @InjectRepository(ProfileXInvite)
    private readonly inviteRepository: Repository<ProfileXInvite>,
    @InjectRepository(ProfileXInviteChallenge)
    private readonly inviteChallengeRepository: Repository<ProfileXInviteChallenge>,
    @InjectRepository(ProfileXInviteCredit)
    private readonly inviteCreditRepository: Repository<ProfileXInviteCredit>,
    @InjectRepository(ProfileXInviteMilestoneReward)
    private readonly milestoneRewardRepository: Repository<ProfileXInviteMilestoneReward>,
    private readonly aeSdkService: AeSdkService,
    private readonly profileSpendQueueService: ProfileSpendQueueService,
    private readonly dataSource: DataSource,
  ) {}

  async createChallenge(params: {
    address: string;
    purpose: 'create' | 'bind';
    code?: string;
  }): Promise<{ nonce: string; expires_at: number; message: string }> {
    this.assertValidAddress(params.address, 'address');
    const code = this.normalizeCode(params.code);
    if (params.purpose === 'bind' && !code) {
      throw new BadRequestException('Invite code is required for bind challenge');
    }
    if (code && !ProfileXInviteService.CODE_REGEX.test(code)) {
      throw new BadRequestException('Invalid invite code format');
    }

    const nonce = randomBytes(24).toString('hex');
    const expiresAt = Date.now() + PROFILE_X_INVITE_CHALLENGE_TTL_SECONDS * 1000;
    const message = this.createChallengeMessage(
      params.purpose,
      params.address,
      code || '',
      nonce,
      expiresAt,
    );

    await this.inviteChallengeRepository.save(
      this.inviteChallengeRepository.create({
        nonce,
        address: params.address,
        purpose: params.purpose,
        invite_code: code || null,
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

  async createInvite(inviterAddress: string): Promise<{
    code: string;
    invite_link: string;
  }>;
  async createInvite(params: {
    inviterAddress: string;
    challengeNonce: string;
    challengeExpiresAt: number;
    signatureHex: string;
  }): Promise<{
    code: string;
    invite_link: string;
  }>;
  async createInvite(
    inviterOrParams:
      | string
      | {
          inviterAddress: string;
          challengeNonce: string;
          challengeExpiresAt: number;
          signatureHex: string;
        },
  ): Promise<{
    code: string;
    invite_link: string;
  }> {
    const params =
      typeof inviterOrParams === 'string'
        ? {
            inviterAddress: inviterOrParams,
            challengeNonce: '',
            challengeExpiresAt: 0,
            signatureHex: '',
          }
        : inviterOrParams;
    const { inviterAddress, challengeNonce, challengeExpiresAt, signatureHex } =
      params;
    this.assertValidAddress(inviterAddress, 'inviter');
    await this.verifyAndConsumeChallenge({
      address: inviterAddress,
      purpose: 'create',
      inviteCode: null,
      nonce: challengeNonce,
      expiresAt: challengeExpiresAt,
      signatureHex,
    });

    const code = await this.generateUniqueCode();
    await this.inviteRepository.save(
      this.inviteRepository.create({
        inviter_address: inviterAddress,
        code,
        status: 'active',
      }),
    );

    return {
      code,
      invite_link: this.buildInviteLink(code),
    };
  }

  async bindInvite(code: string, inviteeAddress: string): Promise<{
    code: string;
    inviter_address: string;
    invitee_address: string;
    status: 'bound';
  }>;
  async bindInvite(params: {
    code: string;
    inviteeAddress: string;
    challengeNonce: string;
    challengeExpiresAt: number;
    signatureHex: string;
  }): Promise<{
    code: string;
    inviter_address: string;
    invitee_address: string;
    status: 'bound';
  }>;
  async bindInvite(
    codeOrParams:
      | string
      | {
          code: string;
          inviteeAddress: string;
          challengeNonce: string;
          challengeExpiresAt: number;
          signatureHex: string;
        },
    inviteeAddressArg?: string,
  ): Promise<{
    code: string;
    inviter_address: string;
    invitee_address: string;
    status: 'bound';
  }> {
    const params =
      typeof codeOrParams === 'string'
        ? {
            code: codeOrParams,
            inviteeAddress: inviteeAddressArg || '',
            challengeNonce: '',
            challengeExpiresAt: 0,
            signatureHex: '',
          }
        : codeOrParams;
    const inviteCode = this.normalizeAndValidateCode(params.code);
    this.assertValidAddress(params.inviteeAddress, 'invitee');
    await this.verifyAndConsumeChallenge({
      address: params.inviteeAddress,
      purpose: 'bind',
      inviteCode,
      nonce: params.challengeNonce,
      expiresAt: params.challengeExpiresAt,
      signatureHex: params.signatureHex,
    });

    return this.dataSource.transaction(async (manager) => {
      const inviteRepo = manager.getRepository(ProfileXInvite);

      const invite = await inviteRepo
        .createQueryBuilder('invite')
        .setLock('pessimistic_write')
        .where('invite.code = :code', { code: inviteCode })
        .getOne();
      if (!invite) {
        throw new BadRequestException('Invite code not found');
      }
      if (invite.inviter_address === params.inviteeAddress) {
        throw new BadRequestException('Inviter cannot bind own invite code');
      }
      if (
        invite.invitee_address === params.inviteeAddress &&
        invite.status === 'bound'
      ) {
        return {
          code: invite.code,
          inviter_address: invite.inviter_address,
          invitee_address: params.inviteeAddress,
          status: 'bound' as const,
        };
      }
      if (invite.invitee_address && invite.invitee_address !== params.inviteeAddress) {
        throw new BadRequestException('Invite code already bound');
      }

      const alreadyBoundForInvitee = await inviteRepo
        .createQueryBuilder('bound')
        .setLock('pessimistic_write')
        .where('bound.invitee_address = :inviteeAddress', {
          inviteeAddress: params.inviteeAddress,
        })
        .getOne();
      if (
        alreadyBoundForInvitee &&
        alreadyBoundForInvitee.code !== invite.code &&
        alreadyBoundForInvitee.status === 'bound'
      ) {
        throw new BadRequestException('Invitee already bound to another invite');
      }

      invite.invitee_address = params.inviteeAddress;
      invite.status = 'bound';
      invite.bound_at = new Date();
      await inviteRepo.save(invite);

      return {
        code: invite.code,
        inviter_address: invite.inviter_address,
        invitee_address: params.inviteeAddress,
        status: 'bound' as const,
      };
    });
  }

  async processInviteeXVerified(inviteeAddress: string): Promise<void> {
    if (!inviteeAddress) {
      return;
    }

    const invite = await this.inviteRepository.findOne({
      where: { invitee_address: inviteeAddress, status: 'bound' },
    });
    if (!invite) {
      return;
    }

    const insertResult = await this.inviteCreditRepository
      .createQueryBuilder()
      .insert()
      .into(ProfileXInviteCredit)
      .values({
        inviter_address: invite.inviter_address,
        invitee_address: inviteeAddress,
        invite_code: invite.code,
      })
      .orIgnore()
      .execute();
    if ((insertResult.identifiers || []).length === 0) {
      return;
    }

    const verifiedFriendsCount = await this.inviteCreditRepository.count({
      where: { inviter_address: invite.inviter_address },
    });
    if (verifiedFriendsCount >= PROFILE_X_INVITE_MILESTONE_THRESHOLD) {
      try {
        await this.sendMilestoneRewardIfEligible(invite.inviter_address);
      } catch {
        // Do not block verification flow if milestone payout fails.
      }
    }
  }

  async getProgress(inviterAddress: string): Promise<InviteProgress> {
    this.assertValidAddress(inviterAddress, 'inviter');

    const [verifiedFriendsCount, milestoneReward] = await Promise.all([
      this.inviteCreditRepository.count({
        where: { inviter_address: inviterAddress },
      }),
      this.milestoneRewardRepository.findOne({
        where: {
          inviter_address: inviterAddress,
          threshold: PROFILE_X_INVITE_MILESTONE_THRESHOLD,
        },
      }),
    ]);

    return {
      inviter_address: inviterAddress,
      verified_friends_count: verifiedFriendsCount,
      goal: PROFILE_X_INVITE_MILESTONE_THRESHOLD,
      remaining_to_goal: Math.max(
        PROFILE_X_INVITE_MILESTONE_THRESHOLD - verifiedFriendsCount,
        0,
      ),
      milestone_reward_status: milestoneReward?.status ?? 'not_started',
      milestone_reward_tx_hash: milestoneReward?.tx_hash ?? null,
    };
  }

  private async sendMilestoneRewardIfEligible(
    inviterAddress: string,
  ): Promise<void> {
    if (!PROFILE_X_INVITE_MILESTONE_REWARD_PRIVATE_KEY) {
      this.logger.warn(
        'Skipping invite milestone reward, PROFILE_X_INVITE_MILESTONE_REWARD_PRIVATE_KEY is not configured',
      );
      return;
    }
    if (!this.isValidAeAmount(PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE)) {
      this.logger.warn(
        `Skipping invite milestone reward, invalid PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE: ${PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE}`,
      );
      return;
    }
    const rewardAmountAettos = this.getRewardAmountAettos();
    if (!rewardAmountAettos) {
      return;
    }

    let rewardEntry: ProfileXInviteMilestoneReward | null = null;
    await this.dataSource.transaction(async (manager) => {
      const rewardRepo = manager.getRepository(ProfileXInviteMilestoneReward);
      rewardEntry = await rewardRepo
        .createQueryBuilder('reward')
        .setLock('pessimistic_write')
        .where('reward.inviter_address = :inviterAddress', { inviterAddress })
        .andWhere('reward.threshold = :threshold', {
          threshold: PROFILE_X_INVITE_MILESTONE_THRESHOLD,
        })
        .getOne();
      const pendingTimeoutMs = PROFILE_X_INVITE_PENDING_TIMEOUT_SECONDS * 1000;
      const isStalePending =
        rewardEntry?.status === 'pending' &&
        !!rewardEntry.updated_at &&
        Date.now() - rewardEntry.updated_at.getTime() > pendingTimeoutMs;
      if (rewardEntry?.status === 'paid') {
        return;
      }
      if (rewardEntry?.status === 'pending' && !isStalePending) {
        return;
      }

      rewardEntry =
        rewardEntry ||
        rewardRepo.create({
          inviter_address: inviterAddress,
          threshold: PROFILE_X_INVITE_MILESTONE_THRESHOLD,
        });
      rewardEntry.status = 'pending';
      rewardEntry.error = null;
      await rewardRepo.save(rewardEntry);
    });
    if (!rewardEntry || rewardEntry.status !== 'pending') {
      return;
    }

    await this.profileSpendQueueService.enqueueSpend(
      PROFILE_X_INVITE_MILESTONE_REWARD_PRIVATE_KEY,
      async () => {
      try {
        const rewardAccount = this.profileSpendQueueService.getRewardAccount(
          PROFILE_X_INVITE_MILESTONE_REWARD_PRIVATE_KEY,
          'PROFILE_X_INVITE_MILESTONE_REWARD_PRIVATE_KEY',
        );
        const spendResult = await this.aeSdkService.sdk.spend(
          rewardAmountAettos,
          inviterAddress as `ak_${string}`,
          { onAccount: rewardAccount },
        );
        rewardEntry.tx_hash = spendResult.hash || null;
        rewardEntry.status = 'paid';
        rewardEntry.error = null;
        await this.milestoneRewardRepository.save(rewardEntry);
      } catch (error: any) {
        rewardEntry.status = 'failed';
        rewardEntry.error =
          error instanceof Error
            ? error.message
            : String(error || 'Unknown error');
        await this.milestoneRewardRepository.save(rewardEntry);
        this.logger.error(
          `Failed to send invite milestone reward to ${inviterAddress}`,
          error?.stack || error,
        );
        throw error;
      }
      },
    );
  }

  private isValidAeAmount(value: string): boolean {
    if (!/^\d+(\.\d+)?$/.test(value)) {
      return false;
    }
    return Number(value) > 0;
  }

  private getRewardAmountAettos(): string | null {
    try {
      const amount = toAettos(PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE);
      if (!/^\d+$/.test(amount) || amount === '0') {
        this.logger.error(
          `Skipping invite milestone reward, converted aettos amount is invalid: ${amount}`,
        );
        return null;
      }
      return amount;
    } catch (error) {
      this.logger.error(
        'Skipping invite milestone reward, failed to convert amount to aettos',
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  private assertValidAddress(address: string, label: string): void {
    if (!ProfileXInviteService.ADDRESS_REGEX.test(address || '')) {
      throw new BadRequestException(`Invalid ${label} address`);
    }
  }

  private async generateUniqueCode(): Promise<string> {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (let attempt = 0; attempt < 10; attempt++) {
      const bytes = randomBytes(12);
      let code = '';
      for (let i = 0; i < 12; i++) {
        code += alphabet[bytes[i] % alphabet.length];
      }
      const existing = await this.inviteRepository.findOne({ where: { code } });
      if (!existing) {
        return code;
      }
    }
    throw new BadRequestException('Failed to generate unique invite code');
  }

  private buildInviteLink(code: string): string {
    if (!PROFILE_X_INVITE_LINK_BASE_URL) {
      return code;
    }
    const base = PROFILE_X_INVITE_LINK_BASE_URL.replace(/\/+$/, '');
    return `${base}?xInvite=${encodeURIComponent(code)}`;
  }

  private normalizeCode(code: string | undefined): string | null {
    const trimmed = (code || '').trim().toLowerCase();
    return trimmed || null;
  }

  private normalizeAndValidateCode(code: string): string {
    const normalized = this.normalizeCode(code);
    if (!normalized) {
      throw new BadRequestException('Invite code is required');
    }
    if (!ProfileXInviteService.CODE_REGEX.test(normalized)) {
      throw new BadRequestException('Invalid invite code format');
    }
    return normalized;
  }

  private createChallengeMessage(
    purpose: 'create' | 'bind',
    address: string,
    inviteCode: string,
    nonce: string,
    expiresAt: number,
  ): string {
    return `profile_x_invite:${purpose}:${address}:${inviteCode}:${nonce}:${expiresAt}`;
  }

  private async verifyAndConsumeChallenge(params: {
    address: string;
    purpose: 'create' | 'bind';
    inviteCode: string | null;
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
      const challengeRepo = manager.getRepository(ProfileXInviteChallenge);
      const challenge = await challengeRepo
        .createQueryBuilder('challenge')
        .setLock('pessimistic_write')
        .where('challenge.nonce = :nonce', { nonce: params.nonce })
        .andWhere('challenge.address = :address', { address: params.address })
        .andWhere('challenge.purpose = :purpose', { purpose: params.purpose })
        .andWhere('challenge.consumed_at IS NULL')
        .getOne();
      if (!challenge) {
        throw new BadRequestException('Challenge not found');
      }
      const challengeCode = challenge.invite_code || null;
      if (challengeCode !== params.inviteCode) {
        throw new BadRequestException('Challenge invite code mismatch');
      }
      if (challenge.expires_at.getTime() !== params.expiresAt) {
        throw new BadRequestException('Challenge expiry mismatch');
      }
      if (challenge.expires_at.getTime() <= now) {
        throw new BadRequestException('Challenge has expired');
      }

      const message = this.createChallengeMessage(
        params.purpose,
        params.address,
        params.inviteCode || '',
        params.nonce,
        params.expiresAt,
      );
      if (
        !this.verifyAddressSignature(
          params.address,
          message,
          params.signatureHex.toLowerCase(),
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
}
