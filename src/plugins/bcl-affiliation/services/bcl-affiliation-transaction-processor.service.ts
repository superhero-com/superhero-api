import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { SyncDirection } from '../../plugin.interface';
import { SyncDirectionEnum } from '@/mdw-sync/types/sync-direction';
import { toAe } from '@aeternity/aepp-sdk';
import moment from 'moment';
import { Invitation } from '@/affiliation/entities/invitation.entity';
import {
  INVITATION_CLAIMED_EVENT,
  InvitationClaimedEventPayload,
} from '../events';

/**
 * Outcome of one of the save* helpers: the persisted invitations plus any
 * post-commit events the caller should emit AFTER the surrounding transaction
 * resolves successfully. The events MUST NOT be emitted inside the transaction
 * callback — a commit failure after emit would send a phantom notification.
 */
interface ProcessOutcome {
  invitations: Invitation[] | null;
  events: InvitationClaimedEventPayload[];
}

@Injectable()
export class BclAffiliationTransactionProcessorService {
  private readonly logger = new Logger(
    BclAffiliationTransactionProcessorService.name,
  );

  constructor(
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Process an affiliation transaction
   * @param tx - Transaction entity from MDW sync
   * @param syncDirection - Sync direction (backward/live/reorg)
   * @returns Processed invitations or null if transaction should be skipped
   */
  async processTransaction(
    tx: Tx,
    syncDirection: SyncDirection,
  ): Promise<Invitation[] | null> {
    try {
      // Check transaction result
      if (tx.raw.result !== 'ok') {
        return null;
      }

      const functionName = tx.function;
      if (!functionName) {
        return null;
      }

      // Wrap operations in a transaction for consistency. Events the save
      // helpers want to emit are returned alongside the invitations and
      // emitted AFTER commit (see below) — emitting inside the callback would
      // leak phantom notifications on rollback.
      const outcome =
        await this.invitationRepository.manager.transaction<ProcessOutcome>(
          async (manager) => {
            switch (functionName) {
              case 'register_invitation_code':
                return {
                  invitations: await this.saveRegisterInvitation(tx, manager),
                  events: [],
                };
              case 'redeem_invitation_code':
                return await this.saveClaimInvitation(tx, manager);
              case 'revoke_invitation_code':
                return {
                  invitations: await this.saveRevokeInvitation(tx, manager),
                  events: [],
                };
              default:
                return { invitations: null, events: [] };
            }
          },
        );

      // Backfill / reorg replays would re-emit historical claims and page
      // every inviter for every old redeem — gate on Live so only fresh chain
      // events trigger notifications.
      if (syncDirection === SyncDirectionEnum.Live) {
        for (const event of outcome.events) {
          this.eventEmitter.emit(INVITATION_CLAIMED_EVENT, event);
        }
      }

      return outcome.invitations;
    } catch (error: any) {
      this.logger.error(
        `Failed to process affiliation transaction ${tx.hash}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Save register invitation transaction - creates invitations for each invitee
   */
  private async saveRegisterInvitation(
    tx: Tx,
    manager: EntityManager,
  ): Promise<Invitation[]> {
    const invitationRepository = manager.getRepository(Invitation);

    const senderAddress = tx.caller_id;
    const inviteesArgs = tx.raw.arguments?.[0];

    if (!inviteesArgs || !inviteesArgs.value) {
      return [];
    }

    const inviteesAccounts: string[] = [];
    for (const invitee of inviteesArgs.value) {
      if (invitee.type === 'address') {
        inviteesAccounts.push(invitee.value);
      }
    }

    const amountArgs = tx.raw.arguments?.[2];
    const amount = amountArgs?.value ? toAe(amountArgs.value) : '0';
    const microTime = parseInt(tx.micro_time, 10);

    const savedInvitations: Invitation[] = [];

    for (const invitee of inviteesAccounts) {
      // Check if invitation already exists (unique by tx_hash and receiver_address)
      const existingInvitation = await invitationRepository.findOne({
        where: {
          tx_hash: tx.hash,
          receiver_address: invitee,
        },
      });

      if (existingInvitation) {
        savedInvitations.push(existingInvitation);
        continue;
      }

      const invitation = await invitationRepository.save({
        tx_hash: tx.hash,
        receiver_address: invitee,
        block_height: tx.block_height,
        amount: amount.toString(),
        sender_address: senderAddress,
        created_at: moment(microTime).toDate(),
      });

      savedInvitations.push(invitation);
    }

    return savedInvitations;
  }

  /**
   * Save claim invitation transaction - updates invitation status to 'claimed'.
   * Returns the persisted invitations PLUS the post-commit event payload; the
   * caller emits the event only after the transaction commits, gated on Live.
   */
  private async saveClaimInvitation(
    tx: Tx,
    manager: EntityManager,
  ): Promise<ProcessOutcome> {
    const invitationRepository = manager.getRepository(Invitation);

    const callerAddress = tx.caller_id;
    const receiverAddress = tx.raw.arguments?.[0]?.value;

    if (!callerAddress || !receiverAddress) {
      return { invitations: null, events: [] };
    }

    const invitation = await invitationRepository.findOne({
      where: {
        receiver_address: callerAddress,
      },
    });

    if (!invitation) {
      this.logger.warn(
        `No invitation found for claim by address: ${callerAddress}`,
      );
      return { invitations: null, events: [] };
    }

    const microTime = parseInt(tx.micro_time, 10);

    await invitationRepository.update(invitation.id, {
      claim_tx_hash: tx.hash,
      invitee_address: receiverAddress,
      status: 'claimed',
      status_updated_at: moment(microTime).toDate(),
    });

    // Return updated invitation
    const updatedInvitation = await invitationRepository.findOne({
      where: { id: invitation.id },
    });

    // Build the post-commit event payload. The listener owns missing-field /
    // self-event gating; we only check the sender_address null here because
    // we need it to populate the payload at all.
    const events: InvitationClaimedEventPayload[] = [];
    if (updatedInvitation?.sender_address) {
      events.push({
        invitationId: updatedInvitation.id,
        inviterAddress: updatedInvitation.sender_address,
        claimerAddress: callerAddress,
        amountAe: updatedInvitation.amount ?? '0',
        txHash: tx.hash,
      });
    }

    return {
      invitations: updatedInvitation ? [updatedInvitation] : null,
      events,
    };
  }

  /**
   * Save revoke invitation transaction - updates invitation status to 'revoked'
   */
  private async saveRevokeInvitation(
    tx: Tx,
    manager: EntityManager,
  ): Promise<Invitation[] | null> {
    const invitationRepository = manager.getRepository(Invitation);

    const receiverAddress = tx.raw.arguments?.[0]?.value;

    if (!receiverAddress) {
      return null;
    }

    const invitation = await invitationRepository.findOne({
      where: {
        receiver_address: receiverAddress,
      },
    });

    if (!invitation) {
      this.logger.warn(
        `No invitation found for revoke by address: ${receiverAddress}`,
      );
      return null;
    }

    const microTime = parseInt(tx.micro_time, 10);

    await invitationRepository.update(invitation.id, {
      revoke_tx_hash: tx.hash,
      invitee_address: null,
      status: 'revoked',
      status_updated_at: moment(microTime).toDate(),
    });

    // Return updated invitation
    const updatedInvitation = await invitationRepository.findOne({
      where: { id: invitation.id },
    });

    return updatedInvitation ? [updatedInvitation] : null;
  }
}
