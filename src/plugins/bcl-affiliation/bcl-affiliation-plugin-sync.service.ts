import { AeSdkService } from '@/ae/ae-sdk.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { serializeBigInts } from '@/utils/common';
import { toAe } from '@aeternity/aepp-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import AffiliationTreasuryACI from '../bcl/contract/aci/AffiliationTreasury.aci.json';
import { SyncDirection } from '../plugin.interface';
import { BCL_AFFILIATION_CONTRACT } from './config/bcl-affiliation.config';
import { BclAffiliationTransactionProcessorService } from './services/bcl-affiliation-transaction-processor.service';

@Injectable()
export class BclAffiliationPluginSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(BclAffiliationPluginSyncService.name);
  readonly pluginName = 'bcl-affiliation';

  constructor(
    aeSdkService: AeSdkService,
    private readonly bclAffiliationTransactionProcessorService: BclAffiliationTransactionProcessorService,
  ) {
    super(aeSdkService);
  }

  async processTransaction(
    tx: Tx,
    syncDirection: SyncDirection,
  ): Promise<void> {
    try {
      // Delegate transaction processing to processor service
      const result =
        await this.bclAffiliationTransactionProcessorService.processTransaction(
          tx,
          syncDirection,
        );

      if (result && result.length > 0) {
        this.logger.debug('Affiliation transaction processed successfully', {
          txHash: tx.hash,
          function: tx.function,
          invitationsProcessed: result.length,
          syncDirection,
        });
      } else {
        this.logger.debug('Affiliation transaction skipped or failed', {
          txHash: tx.hash,
          function: tx.function,
          syncDirection,
        });
      }
    } catch (error: any) {
      this.handleError(error, tx, 'processTransaction');
      throw error; // Re-throw to let BasePluginSyncService handle it
    }
  }

  async decodeLogs(tx: Tx): Promise<any | null> {
    if (!tx?.raw?.log) {
      return null;
    }
    try {
      // Prefer decoding against the contract address on the tx itself, to avoid config/network mismatches.

      const contract = await this.getContract(BCL_AFFILIATION_CONTRACT.contractAddress, AffiliationTreasuryACI);
      const decodedLogs = contract.$decodeEvents(tx.raw.log);
      return serializeBigInts(decodedLogs);
    } catch (error: any) {
      // this.logger.error(
      //   `Failed to decode logs for transaction ${tx.hash}`,
      //   error.stack,
      // );
      return null;
    }
  }

  async decodeData(tx: Tx): Promise<any | null> {
    const pluginLogs = tx.logs?.[this.pluginName];
    const txType = tx.function;
    if (!pluginLogs?.data?.length || !txType) {
      return null;
    }

    // note the data is a multiple invitations
    const invitations = []
    if (txType === BCL_AFFILIATION_CONTRACT.FUNCTIONS.register_invitation_code) {
      for (const invitation of pluginLogs.data) {
        invitations.push({
          inviter: invitation.args?.[0] ?? null,
          invitee: invitation.args?.[1] ?? null,
          amount: toAe(invitation.args?.[2] ?? null),
        });
      }

    }

    if (txType === BCL_AFFILIATION_CONTRACT.FUNCTIONS.redeem_invitation_code) {
      for (const invitation of pluginLogs.data) {
        invitations.push({
          inviter: invitation.args?.[1] ?? null,
          invitee: invitation.args?.[0] ?? null,
          redeemer: invitation.args?.[2] ?? null,
        });
      }
    }

    if (txType === BCL_AFFILIATION_CONTRACT.FUNCTIONS.revoke_invitation_code) {
      for (const invitation of pluginLogs.data) {
        invitations.push({
          inviter: invitation.args?.[1] ?? null,
          invitee: invitation.args?.[0] ?? null,
        });
      }
    }

    return {
      invitations,
      inviter: tx.caller_id,
      contract: pluginLogs.data?.[0]?.contract?.address,
      event_name: pluginLogs.data?.[0]?.name,
    }
  }
}

