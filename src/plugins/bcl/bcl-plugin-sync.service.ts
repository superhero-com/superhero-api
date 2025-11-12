import { Injectable, Logger } from '@nestjs/common';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection, SyncDirectionEnum } from '../plugin.interface';
import { TransactionProcessorService } from './services/transaction-processor.service';
import { TokenWebsocketGateway } from '@/tokens/token-websocket.gateway';
import { AeSdkService } from '@/ae/ae-sdk.service';

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


    return null;

  }
}

