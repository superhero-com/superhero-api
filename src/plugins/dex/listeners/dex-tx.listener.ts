import { BasePluginTxListener } from '@/mdw-sync/plugins/base-plugin-tx.listener';
import { Plugin } from '@/mdw-sync/plugins/plugin.interface';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { Injectable, Logger } from '@nestjs/common';
import { DexPlugin } from '../dex.plugin';
import { DexSyncTransactionService } from '../services/dex-sync-transaction.service';

@Injectable()
export class DexTxListener extends BasePluginTxListener {
  protected readonly logger = new Logger(DexTxListener.name);

  constructor(
    private readonly dexPlugin: DexPlugin,
    private readonly dexSyncService: DexSyncTransactionService,
  ) {
    super();
  }

  protected getPlugin(): Plugin {
    return this.dexPlugin;
  }

  protected getSyncService(): BasePluginSyncService {
    return this.dexSyncService;
  }
}
