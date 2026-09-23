import { Injectable, Logger } from '@nestjs/common';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { Tx, SyncDirection } from '@/plugins/plugin.interface';
import { BasePluginSyncService } from '@/plugins/base-plugin-sync.service';
import { SocialGraphWorkerService } from '../social-graph-worker.service';

@Injectable()
export class SocialGraphTransactionProcessorService extends BasePluginSyncService {
  protected readonly logger = new Logger(
    SocialGraphTransactionProcessorService.name,
  );

  constructor(
    ae: AeSdkService,
    private readonly worker: SocialGraphWorkerService,
  ) {
    super(ae);
  }

  async processTransaction(tx: Tx, direction: SyncDirection): Promise<void> {
    // The shared plugin pipeline delivers live/backward/reorg transactions. Wake
    // the durable ordered consumer: applying this isolated hint directly could
    // reorder follow/unfollow or miss an indirect call during a socket outage.
    if (!tx.hash) throw new Error('Missing social graph transaction hash');
    this.logger.debug(`Social graph ${direction} transaction ${tx.hash}`);
    this.worker.requestSync({ hash: tx.block_hash, height: tx.block_height });
  }
}
