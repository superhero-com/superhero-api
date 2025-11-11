import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BasePlugin } from '../base-plugin';
import { PluginFilter } from '../plugin.interface';
import { GovernancePluginSyncService } from './governance-plugin-sync.service';
import { getContractAddress, getStartHeight } from './config/governance.config';

@Injectable()
export class GovernancePlugin extends BasePlugin {
  protected readonly logger = new Logger(GovernancePlugin.name);
  readonly name = 'governance';
  readonly version = 1;

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private governancePluginSyncService: GovernancePluginSyncService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  startFromHeight(): number {
    const config = this.configService.get<{ contract: { startHeight: number } }>(
      'governance',
    );
    return config?.contract?.startHeight ?? getStartHeight();
  }

  filters(): PluginFilter[] {
    const config = this.configService.get<{ contract: { contractAddress: string } }>(
      'governance',
    );
    const contractAddress = config?.contract?.contractAddress ?? getContractAddress();

    if (!contractAddress) {
      this.logger.warn('[Governance] No contract address configured');
      return [];
    }

    return [
      {
        predicate: (tx: Partial<Tx>) => {
          return (
            tx.type === 'ContractCallTx' &&
            !!tx.contract_id &&
            tx.contract_id === contractAddress
          );
        },
      },
    ];
  }

  protected getSyncService(): GovernancePluginSyncService {
    return this.governancePluginSyncService;
  }
}

