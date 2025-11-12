import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BasePlugin } from '../base-plugin';
import { PluginFilter } from '../plugin.interface';
import { GovernancePluginSyncService } from './governance-plugin-sync.service';
import { getContractAddress, getStartHeight, GOVERNANCE_CONTRACT } from './config/governance.config';

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
  getUpdateQueries(pluginName: string, currentVersion: number): Array<(repository: Repository<Tx>, limit: number, cursor?: { block_height: number; micro_time: string }) => Promise<Tx[]>> {
    const supportedFunctions = Object.values(GOVERNANCE_CONTRACT.FUNCTIONS);
    
    return [
      async (repo, limit, cursor) => {
        const query = repo.createQueryBuilder('tx')
          .where('tx.function IN (:...supportedFunctions)', { supportedFunctions })
          .andWhere(
            `(tx.data->>'${pluginName}' IS NULL OR (tx.data->'${pluginName}'->>'_version')::int != :version)`,
            { version: currentVersion }
          );
        
        // Apply cursor for pagination (cursor-based instead of offset-based)
        if (cursor) {
          query.andWhere(
            '(tx.block_height > :cursorHeight OR (tx.block_height = :cursorHeight AND tx.micro_time > :cursorMicroTime))',
            {
              cursorHeight: cursor.block_height,
              cursorMicroTime: cursor.micro_time,
            }
          );
        }
        
        return query
          .orderBy('tx.block_height', 'ASC')
          .addOrderBy('tx.micro_time', 'ASC')
          .take(limit)
          .getMany();
      }
    ];
  }
}

