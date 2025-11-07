import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BasePlugin } from '../base-plugin';
import { PluginFilter } from '../plugin.interface';
import { SocialPluginSyncService } from './social-plugin-sync.service';
import { POST_CONTRACTS } from '@/social/config/post-contracts.config';

@Injectable()
export class SocialPlugin extends BasePlugin {
  protected readonly logger = new Logger(SocialPlugin.name);
  readonly name = 'social';
  readonly version = 1;

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private socialPluginSyncService: SocialPluginSyncService,
  ) {
    super();
  }

  startFromHeight(): number {
    // Start from the earliest contract deployment
    // For now, use a default height - can be configured later
    return 0;
  }

  filters(): PluginFilter[] {
    const contractAddresses = POST_CONTRACTS.map((contract) => contract.contractAddress);

    if (contractAddresses.length === 0) {
      this.logger.warn('[Social] No post contracts configured');
      return [];
    }

    return [
      {
        type: 'contract_call',
        contractIds: contractAddresses,
      },
    ];
  }

  protected getSyncService(): SocialPluginSyncService {
    return this.socialPluginSyncService;
  }
}

