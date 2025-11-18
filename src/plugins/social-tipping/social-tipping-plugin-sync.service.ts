import { Injectable, Logger } from '@nestjs/common';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection } from '../plugin.interface';
import { SocialTippingTransactionProcessorService } from './services/social-tipping-transaction-processor.service';

@Injectable()
export class SocialTippingPluginSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(SocialTippingPluginSyncService.name);

  constructor(
    aeSdkService: AeSdkService,
    private readonly socialTippingTransactionProcessorService: SocialTippingTransactionProcessorService,
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
        await this.socialTippingTransactionProcessorService.processTransaction(
          tx,
          syncDirection,
        );

      if (result) {
        this.logger.debug('Tip transaction processed successfully', {
          txHash: tx.hash,
          tipType: result.type,
          syncDirection,
        });
      } else {
        this.logger.debug('Tip transaction skipped or failed', {
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

