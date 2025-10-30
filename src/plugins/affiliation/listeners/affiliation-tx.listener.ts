import { BasePluginTxListener } from '@/mdw-sync/plugins/base-plugin-tx.listener';
import { Plugin } from '@/mdw-sync/plugins/plugin.interface';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { Injectable, Logger } from '@nestjs/common';
import { AffiliationPlugin } from '../affiliation.plugin';
import { AffiliationSyncTransactionService } from '../services/affiliation-sync-transaction.service';

@Injectable()
export class AffiliationTxListener extends BasePluginTxListener {
  protected readonly logger = new Logger(AffiliationTxListener.name);

  constructor(
    private readonly affiliationPlugin: AffiliationPlugin,
    private readonly affiliationSyncService: AffiliationSyncTransactionService,
  ) {
    super();
  }

  protected getPlugin(): Plugin {
    return this.affiliationPlugin;
  }

  protected getSyncService(): BasePluginSyncService {
    return this.affiliationSyncService;
  }
}
