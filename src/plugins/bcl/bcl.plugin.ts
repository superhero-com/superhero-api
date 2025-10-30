import { BCL_FUNCTIONS } from '@/configs/constants';
import { BCL_FACTORY } from '@/configs/contracts';
import { ACTIVE_NETWORK_ID } from '@/configs/network';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { BasePlugin } from '@/mdw-sync/plugins/base-plugin';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { PluginFilter } from '@/mdw-sync/plugins/plugin.interface';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BclSyncTransactionService } from './services/bcl-sync-transaction.service';

@Injectable()
export class BclPlugin extends BasePlugin {
  readonly version = 1;
  readonly name = 'bcl';
  protected readonly logger = new Logger(BclPlugin.name);

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private readonly bclSyncService: BclSyncTransactionService,
  ) {
    super();
  }

  protected getSyncService(): BasePluginSyncService {
    return this.bclSyncService;
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
        contractIds: [factory.address],
        functions: Object.values(BCL_FUNCTIONS),
      },
    ];
  }
}
