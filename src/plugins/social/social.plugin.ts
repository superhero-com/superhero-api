import { BasePlugin } from '@/mdw-sync/plugins/base-plugin';
import { PluginFilter } from '@/mdw-sync/plugins/plugin.interface';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { POST_CONTRACTS } from './config/post-contracts.config';
import { SocialSyncTransactionService } from './services/social-sync-transaction.service';

@Injectable()
export class SocialPlugin extends BasePlugin {
  readonly version = 1;
  readonly name = 'social';
  protected readonly logger = new Logger(SocialPlugin.name);

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private readonly socialSyncService: SocialSyncTransactionService,
  ) {
    super();
  }

  protected getSyncService(): BasePluginSyncService {
    return this.socialSyncService;
  }

  startFromHeight(): number {
    // Start from a reasonable height where social contracts were deployed
    return 100000; // Adjust based on your network
  }

  filters(): PluginFilter[] {
    return [
      {
        type: 'contract_call' as const,
        contractIds: POST_CONTRACTS.map((contract) => contract.contractAddress),
        functions: ['create_post', 'create_comment'],
      },
    ];
  }
}
