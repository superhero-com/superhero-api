import { BasePluginTxListener } from '@/mdw-sync/plugins/base-plugin-tx.listener';
import { Plugin } from '@/mdw-sync/plugins/plugin.interface';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { Injectable, Logger } from '@nestjs/common';
import { TippingPlugin } from '../tipping.plugin';
import { TippingSyncTransactionService } from '../services/tipping-sync-transaction.service';

@Injectable()
export class TippingTxListener extends BasePluginTxListener {
  protected readonly logger = new Logger(TippingTxListener.name);

  constructor(
    private readonly tippingPlugin: TippingPlugin,
    private readonly tippingSyncService: TippingSyncTransactionService,
  ) {
    super();
  }

  protected getPlugin(): Plugin {
    return this.tippingPlugin;
  }

  protected getSyncService(): BasePluginSyncService {
    return this.tippingSyncService;
  }
}
