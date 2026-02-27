import { Injectable, Logger } from '@nestjs/common';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection } from '../plugin.interface';
import { PostTransactionProcessorService } from './services/post-transaction-processor.service';

@Injectable()
export class SocialPluginSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(SocialPluginSyncService.name);

  constructor(
    aeSdkService: AeSdkService,
    private readonly postTransactionProcessorService: PostTransactionProcessorService,
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
        await this.postTransactionProcessorService.processTransaction(tx);

      if (result && result.success && result.post) {
        this.logger.debug('Post transaction processed successfully', {
          txHash: tx.hash,
          postId: result.post.id,
          syncDirection,
        });
      } else if (result && result.skipped) {
        this.logger.debug('Post transaction skipped', {
          txHash: tx.hash,
          reason: result.error,
          syncDirection,
        });
      } else if (result && !result.success) {
        this.logger.warn('Post transaction processing failed', {
          txHash: tx.hash,
          error: result.error,
          syncDirection,
        });
      }
    } catch (error: any) {
      this.handleError(error, tx, 'processTransaction');
      throw error; // Re-throw to let BasePluginSyncService handle it
    }
  }
}
