import { BasePluginTxListener } from '@/mdw-sync/plugins/base-plugin-tx.listener';
import { Plugin } from '@/mdw-sync/plugins/plugin.interface';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { Injectable, Logger } from '@nestjs/common';
import { BclPlugin } from '../bcl.plugin';
import { BclSyncTransactionService } from '../services/bcl-sync-transaction.service';

@Injectable()
export class BclTxListener extends BasePluginTxListener {
  protected readonly logger = new Logger(BclTxListener.name);

  constructor(
    private readonly bclPlugin: BclPlugin,
    private readonly bclSyncService: BclSyncTransactionService,
  ) {
    super();
  }

  protected getPlugin(): Plugin {
    return this.bclPlugin;
  }

  protected getSyncService(): BasePluginSyncService {
    return this.bclSyncService;
  }
}
