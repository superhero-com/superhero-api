import { Injectable, Logger } from '@nestjs/common';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection } from '../plugin.interface';
import { BclAffiliationTransactionProcessorService } from './services/bcl-affiliation-transaction-processor.service';

@Injectable()
export class BclAffiliationPluginSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(BclAffiliationPluginSyncService.name);

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
}
