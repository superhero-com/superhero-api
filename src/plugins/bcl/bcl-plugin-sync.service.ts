import { AeSdkService } from '@/ae/ae-sdk.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { TokenWebsocketGateway } from '@/tokens/token-websocket.gateway';
import { Injectable, Logger } from '@nestjs/common';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection, SyncDirectionEnum } from '../plugin.interface';
import { BCL_CONTRACT } from './config/bcl.config';
import { TransactionProcessorService } from './services/transaction-processor.service';

import { serializeBigInts } from '@/utils/common';
import CommunityFactoryACI from './contract/aci/CommunityFactory.aci.json';

@Injectable()
export class BclPluginSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(BclPluginSyncService.name);

  constructor(
    private readonly transactionProcessorService: TransactionProcessorService,
    private readonly tokenWebsocketGateway: TokenWebsocketGateway,
    aeSdkService: AeSdkService,
  ) {
    super(aeSdkService);
  }

  async processTransaction(
    rawTransaction: Tx,
    syncDirection: SyncDirection,
  ): Promise<void> {
    try {
      // Delegate transaction processing to processor service
      const result =
        await this.transactionProcessorService.processTransaction(
          rawTransaction,
          syncDirection,
        );

      // Background operations outside transaction
      if (result && result.isSupported && syncDirection === SyncDirectionEnum.Live) {
        // Broadcast transaction via WebSocket
        this.tokenWebsocketGateway?.handleTokenHistory({
          sale_address: result.txData.sale_address,
          data: result.txData,
          token: result.transactionToken,
        });
      }
    } catch (error: any) {
      this.handleError(error, rawTransaction, 'processTransaction');
      throw error; // Re-throw to let BasePluginSyncService handle it
    }
  }


  async decodeLogs(tx: Tx): Promise<any | null> {
    if (!tx?.raw?.log) {
      return null;
    }

    try {
      const contract = await this.getContract(BCL_CONTRACT.contractAddress, CommunityFactoryACI);
      const decodedLogs = contract.$decodeEvents(tx.raw.log, {
        omitUnknown: true,
      });

      return serializeBigInts(decodedLogs);
    } catch (error: any) {
      const isUnknownEventError =
        error?.name === 'MissingEventDefinitionError'
        || error?.message?.includes("Can't find definition");
      if (isUnknownEventError) {
        this.logger.warn(
          `Failed to decode logs for transaction ${tx.hash} due to unknown event definition`,
        );
      } else {
        this.logger.error(
          `Failed to decode logs for transaction ${tx.hash}`,
          error.stack,
        );
      }
      return null;
    }

  }
}

