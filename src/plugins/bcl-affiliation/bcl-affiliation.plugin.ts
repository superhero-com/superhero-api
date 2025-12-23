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
import { BCL_AFFILIATION_CONTRACT } from './config/bcl-affiliation.config';
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

    const contractIds = [affiliationAddress];
    const functions = [
      'register_invitation_code',
      'redeem_invitation_code',
      'revoke_invitation_code',
    ];

    return [
      {
        predicate: (tx: Partial<Tx>) => {
          return (
            tx.type === 'ContractCallTx' &&
            !!tx.contract_id &&
            contractIds.includes(tx.contract_id as any) &&
            !!tx.function &&
            functions.includes(tx.function)
          );
        },
      },
    ];
  }

  protected getSyncService(): BclAffiliationPluginSyncService {
    return this.bclAffiliationPluginSyncService;
  }

  /**
   * TODO: make it generic
   */
  getUpdateQueries(pluginName: string, currentVersion: number): Array<(repository: Repository<Tx>, limit: number, cursor?: { block_height: number; micro_time: string }) => Promise<Tx[]>> {
    const supportedFunctions = Object.values(BCL_AFFILIATION_CONTRACT.FUNCTIONS);
    console.log('==========')
    console.log('==========')
    console.log('===getUpdateQueries=======')
    console.log('==========')
    console.log('==========')
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

