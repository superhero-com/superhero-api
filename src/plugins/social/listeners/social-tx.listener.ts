import { BasePluginTxListener } from '@/mdw-sync/plugins/base-plugin-tx.listener';
import { Plugin } from '@/mdw-sync/plugins/plugin.interface';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { Injectable, Logger } from '@nestjs/common';
import { SocialPlugin } from '../social.plugin';
import { SocialSyncTransactionService } from '../services/social-sync-transaction.service';

@Injectable()
export class SocialTxListener extends BasePluginTxListener {
  protected readonly logger = new Logger(SocialTxListener.name);

  constructor(
    private readonly socialPlugin: SocialPlugin,
    private readonly socialSyncService: SocialSyncTransactionService,
  ) {
    super();
  }

  protected getPlugin(): Plugin {
    return this.socialPlugin;
  }

  protected getSyncService(): BasePluginSyncService {
    return this.socialSyncService;
  }
}
