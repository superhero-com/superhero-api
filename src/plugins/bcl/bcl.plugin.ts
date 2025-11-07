import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BasePlugin } from '../base-plugin';
import { PluginFilter } from '../plugin.interface';
import { BclPluginSyncService } from './bcl-plugin-sync.service';
import { BCL_FACTORY } from '@/configs/contracts';
import { ACTIVE_NETWORK } from '@/configs/network';
import { BCL_FUNCTIONS } from '@/configs/constants';

@Injectable()
export class BclPlugin extends BasePlugin {
  protected readonly logger = new Logger(BclPlugin.name);
  readonly name = 'bcl';
  readonly version = 1;

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private bclPluginSyncService: BclPluginSyncService,
    private configService: ConfigService,
  ) {
    super();
  }

  startFromHeight(): number {
    const networkId = ACTIVE_NETWORK.networkId;
    const bclConfig = BCL_FACTORY[networkId];
    return bclConfig?.deployed_at_block_height || 0;
  }

  filters(): PluginFilter[] {
    const networkId = ACTIVE_NETWORK.networkId;
    const bclConfig = BCL_FACTORY[networkId];
    const contractAddress = bclConfig?.address;

    if (!contractAddress) {
      this.logger.warn(`[BCL] No contract address found for network ${networkId}`);
      return [];
    }

    return [
      {
        type: 'contract_call',
        contractIds: [contractAddress],
        functions: [
          BCL_FUNCTIONS.buy,
          BCL_FUNCTIONS.sell,
          BCL_FUNCTIONS.create_community,
        ],
      },
    ];
  }

  protected getSyncService(): BclPluginSyncService {
    return this.bclPluginSyncService;
  }
}

