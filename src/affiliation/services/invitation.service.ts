import { CommunityFactoryService } from '@/ae/community-factory.service';
import { PULL_INVITATIONS_ENABLED } from '@/configs/constants';
import { ACTIVE_NETWORK } from '@/configs/network';
import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { toAe } from '@aeternity/aepp-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import moment from 'moment';
import { Repository } from 'typeorm';
import { Invitation } from '../entities/invitation.entity';

@Injectable()
export class InvitationService {
  private readonly logger = new Logger(InvitationService.name);

  constructor(
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    private communityFactoryService: CommunityFactoryService,
  ) {
    //
  }

  onModuleInit() {
    if (PULL_INVITATIONS_ENABLED) {
      this.pullAndSaveInvitations();
    }
  }

  async createInvitation(invitation: Invitation): Promise<Invitation> {
    return this.invitationRepository.save(invitation);
  }

  isPlullingInvitations = false;
  async pullAndSaveInvitations() {
    if (this.isPlullingInvitations) {
      return;
    }
    this.isPlullingInvitations = true;
    try {
      const factory = await this.communityFactoryService.getCurrentFactory();

      const queryString = new URLSearchParams({
        direction: 'forward',
        limit: '100',
        type: 'contract_call',
        contract: factory.affiliation_address,
      }).toString();

      const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${queryString}`;
      await this.loadInvitationsFromMdw(url);
    } catch (error) {
      this.logger.error('Error pulling and saving invitations', error);
    }
    this.isPlullingInvitations = false;
  }

  async loadInvitationsFromMdw(url: string) {
    const result = await fetchJson(url);

    const data = result?.data ?? [];
    for (const item of data) {
      await this.saveInvitationTransaction(camelcaseKeysDeep(item));
    }

    if (result.next) {
      return await this.loadInvitationsFromMdw(
        `${ACTIVE_NETWORK.middlewareUrl}${result.next}`,
      );
    }
    return result;
  }

  async saveInvitationTransaction(transaction: ITransaction) {
    switch (transaction.tx.function as any) {
      case 'register_invitation_code':
        await this.saveRegisterInvitation(transaction);
        break;
      case 'redeem_invitation_code':
        await this.saveClaimInvitation(transaction);
        break;
      case 'revoke_invitation_code':
        await this.saveRevokeInvitation(transaction);
        break;
    }
  }

  async saveRegisterInvitation(transaction: ITransaction) {
    if (transaction.tx.result !== 'ok') {
      return;
    }
    const senderAddress = transaction.tx.callerId;
    const inviteesAccounts = [];
    const inveteesArgs = transaction.tx.arguments[0];
    for (const invitee of inveteesArgs.value) {
      if (invitee.type === 'address') {
        inviteesAccounts.push(invitee.value);
      }
    }
    const amountArgs = transaction.tx.arguments[2];
    const amount = toAe(amountArgs.value);

    for (const invitee of inviteesAccounts) {
      // unique by tx_hash and receiver_address
      const existingInvitation = await this.invitationRepository.findOne({
        where: {
          tx_hash: transaction.hash,
          receiver_address: invitee,
        },
      });

      if (existingInvitation) {
        continue;
      }

      await this.invitationRepository.save({
        tx_hash: transaction.hash,
        receiver_address: invitee,
        block_height: transaction.blockHeight,
        amount: Number(amount),
        sender_address: senderAddress,
        created_at: moment(transaction.microTime).toDate(),
      });
    }
  }

  async saveClaimInvitation(transaction: ITransaction) {
    const { tx } = transaction;
    const callerAddress = tx.callerId;
    const receiverAddress = tx.arguments[0].value;

    const invitation = await this.findInvitationByReceiver(callerAddress);
    if (!invitation) {
      this.logger.warn(
        `No invitation found for claim by address: ${callerAddress}`,
      );
      return;
    }

    await this.updateInvitationStatus(invitation.id, {
      claim_tx_hash: transaction.hash,
      invitee_address: receiverAddress,
      status: 'claimed',
      status_updated_at: moment(transaction.microTime).toDate(),
    });
  }

  async saveRevokeInvitation(transaction: ITransaction) {
    const { tx } = transaction;
    const receiverAddress = tx.arguments[0].value;

    const invitation = await this.findInvitationByReceiver(receiverAddress);
    if (!invitation) {
      this.logger.warn(
        `No invitation found for revoke by address: ${receiverAddress}`,
      );
      return;
    }

    await this.updateInvitationStatus(invitation.id, {
      revoke_tx_hash: transaction.hash,
      invitee_address: null,
      status: 'revoked',
      status_updated_at: moment(transaction.microTime).toDate(),
    });
  }

  private async findInvitationByReceiver(
    receiverAddress: string,
  ): Promise<Invitation | null> {
    return this.invitationRepository.findOne({
      where: {
        receiver_address: receiverAddress,
      },
    });
  }

  private async updateInvitationStatus(
    invitationId: string,
    updateData: Partial<Invitation>,
  ): Promise<void> {
    await this.invitationRepository.update(invitationId, updateData);
  }
}
