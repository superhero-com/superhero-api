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
  readonly version = 2;

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
        contractIds: [contractAddress],
      },
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

  /**
   * Get queries to retrieve transactions that need auto-updating.
   * Default implementation extracts contract IDs from filters and creates a query.
   * Plugins can override this method to provide custom queries.
   * @param pluginName - The plugin name
   * @param currentVersion - The current plugin version
   * @returns Array of query functions that return transactions needing updates
   */
  getUpdateQueries(pluginName: string, currentVersion: number): Array<(repository: Repository<Tx>, offset: number, limit: number) => Promise<Tx[]>> {
    const filters = this.filters();
    const contractIds: string[] = [];
    
    for (const filter of filters) {
      if (filter.contractIds) {
        contractIds.push(...filter.contractIds);
      }
    }
    
    if (contractIds.length === 0) {
      return [];
    }

    const supportedFunctions = ['add_poll', 'vote', 'revoke_vote'];
    
    return [
      async (repo, offset, limit) => repo.createQueryBuilder('tx')
        .where('tx.function IN (:...supportedFunctions)', { supportedFunctions })
        .andWhere(
          `(tx.data->>'${pluginName}' IS NULL OR (tx.data->'${pluginName}'->>'_version')::int != :version)`,
          { version: currentVersion }
        )
        .orderBy('tx.block_height', 'ASC')
        .addOrderBy('tx.micro_time', 'ASC')
        .skip(offset)
        .take(limit)
        .getMany()
    ];
  }
}

