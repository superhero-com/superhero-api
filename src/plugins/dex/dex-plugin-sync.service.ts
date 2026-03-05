import { Injectable, Logger } from '@nestjs/common';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection } from '../plugin.interface';
import { DexTransactionProcessorService } from './services/dex-transaction-processor.service';

@Injectable()
export class DexPluginSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(DexPluginSyncService.name);

  constructor(
    aeSdkService: AeSdkService,
    private readonly dexTransactionProcessorService: DexTransactionProcessorService,
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
        await this.dexTransactionProcessorService.processTransaction(
          tx,
          syncDirection,
        );

      if (result) {
        this.logger.debug('DEX transaction processed successfully', {
          txHash: tx.hash,
          pairAddress: result.pair?.address,
          syncDirection,
        });
      } else {
        this.logger.debug('DEX transaction skipped or failed', {
          txHash: tx.hash,
          syncDirection,
        });
      }
    } catch (error: any) {
      this.handleError(error, tx, 'processTransaction');
      throw error; // Re-throw to let BasePluginSyncService handle it
    }
  }
}
