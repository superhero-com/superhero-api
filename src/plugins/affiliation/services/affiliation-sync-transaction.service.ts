import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Invitation } from '../entities/invitation.entity';
import { toAe } from '@aeternity/aepp-sdk';
import moment from 'moment';

@Injectable()
export class AffiliationSyncTransactionService extends BasePluginSyncService {
  protected readonly logger = new Logger(
    AffiliationSyncTransactionService.name,
  );

  constructor(
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
  ) {
    super();
  }

  async processTransaction(tx: Tx): Promise<void> {
    try {
      await this.saveInvitationTransaction(tx);
    } catch (error: any) {
      this.handleError(error, tx, 'AffiliationSyncTransactionService');
    }
  }

  async saveInvitationTransaction(tx: Tx) {
    switch (tx.function as any) {
      case 'register_invitation':
        await this.saveRegisterInvitation(tx);
        break;
      case 'claim_invitation':
        await this.saveClaimInvitation(tx);
        break;
      case 'revoke_invitation':
        await this.saveRevokeInvitation(tx);
        break;
    }
  }

  async saveRegisterInvitation(tx: Tx) {
    if (tx.raw.tx.result !== 'ok') {
      return;
    }
    const senderAddress = tx.raw.tx.callerId;

    const inviteesArgs = tx.raw.tx.arguments[0];
    const invitees = inviteesArgs.value.map((invitee: any) => invitee.value);

    const amountArgs = tx.raw.tx.arguments[2];
    const amounts = amountArgs.value.map((amount: any) => toAe(amount.value));

    for (let i = 0; i < invitees.length; i++) {
      await this.invitationRepository.save({
        invitee_address: invitees[i],
        register_tx_hash: tx.tx_hash,
        amount: amounts[i],
      });
    }

    await this.invitationRepository.save({
      register_tx_hash: tx.tx_hash,
      inviter_address: senderAddress,
      block_height: tx.block_height,
      amount: '0',
      status: 'registered',
      created_at: moment(tx.micro_time).toDate(),
    });
  }

  async saveClaimInvitation(tx: Tx) {
    const { tx: transaction } = tx.raw;

    const invitation = await this.invitationRepository.findOne({
      where: {
        invitee_address: transaction.callerId,
      },
    });

    if (!invitation) {
      return;
    }

    await this.invitationRepository.update(invitation.id, {
      claim_tx_hash: tx.tx_hash,
      status: 'claimed',
      status_updated_at: moment(tx.micro_time).toDate(),
    });
  }

  async saveRevokeInvitation(tx: Tx) {
    const { tx: transaction } = tx.raw;

    const addressesArgs = transaction.arguments[0];
    const addresses = addressesArgs.value.map((address: any) => address.value);

    for (const address of addresses) {
      const invitation = await this.invitationRepository.findOne({
        where: { invitee_address: address },
      });

      if (!invitation) {
        continue;
      }

      await this.invitationRepository.update(invitation.id, {
        revoke_tx_hash: tx.tx_hash,
        status: 'revoked',
        status_updated_at: moment(tx.micro_time).toDate(),
      });
    }
  }
}
