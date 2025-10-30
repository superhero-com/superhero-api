import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePlugin } from '@/mdw-sync/plugins/base-plugin';
import { PluginFilter } from '@/mdw-sync/plugins/plugin.interface';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BCL_FACTORY } from '@/configs/contracts';
import { ACTIVE_NETWORK_ID } from '@/configs/network';
import { AffiliationSyncTransactionService } from './services/affiliation-sync-transaction.service';

@Injectable()
export class AffiliationPlugin extends BasePlugin {
  readonly version = 1;
  readonly name = 'affiliation';
  protected readonly logger = new Logger(AffiliationPlugin.name);

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private readonly affiliationSyncService: AffiliationSyncTransactionService,
  ) {
    super();
  }

  protected getSyncService(): BasePluginSyncService {
    return this.affiliationSyncService;
  }

  startFromHeight(): number {
    const factory = BCL_FACTORY[ACTIVE_NETWORK_ID];
    return factory.deployed_at_block_height || 0;
  }

  filters(): PluginFilter[] {
    const factory = BCL_FACTORY[ACTIVE_NETWORK_ID];
    return [
      {
        type: 'contract_call' as const,
        contractIds: [factory.affiliation_address],
        functions: [
          'register_invitation',
          'claim_invitation',
          'revoke_invitation',
        ],
      },
    ];
  }
}
