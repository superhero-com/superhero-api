import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BasePlugin } from '../base-plugin';
import { PluginFilter } from '../plugin.interface';
import { BclAffiliationPluginSyncService } from './bcl-affiliation-plugin-sync.service';
import { BCL_FACTORY } from '@/configs/contracts';
import { ACTIVE_NETWORK } from '@/configs/network';

@Injectable()
export class BclAffiliationPlugin extends BasePlugin {
  protected readonly logger = new Logger(BclAffiliationPlugin.name);
  readonly name = 'bcl-affiliation';
  readonly version = 1;

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private bclAffiliationPluginSyncService: BclAffiliationPluginSyncService,
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
    const affiliationAddress = bclConfig?.affiliation_address;

    if (!affiliationAddress) {
      this.logger.warn(
        `[BCL-Affiliation] No affiliation contract address found for network ${networkId}`,
      );
      return [];
    }

    return [
      {
        type: 'contract_call',
        contractIds: [affiliationAddress],
        functions: [
          'register_invitation_code',
          'redeem_invitation_code',
          'revoke_invitation_code',
        ],
      },
    ];
  }

  protected getSyncService(): BclAffiliationPluginSyncService {
    return this.bclAffiliationPluginSyncService;
  }
}

