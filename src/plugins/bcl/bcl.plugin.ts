import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { BasePlugin } from '../base-plugin';
import { PluginFilter, TxPageCursor } from '../plugin.interface';
import { BclPluginSyncService } from './bcl-plugin-sync.service';
import { BCL_FACTORY } from '@/configs/contracts';
import { ACTIVE_NETWORK } from '@/configs/network';
import { BCL_FUNCTIONS } from '@/configs/constants';
import { BCL_CONTRACT } from './config/bcl.config';

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
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    private bclPluginSyncService: BclPluginSyncService,
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
      this.logger.warn(
        `[BCL] No contract address found for network ${networkId}`,
      );
      return [];
    }

    const contractIds = [contractAddress];
    const functions = [
      BCL_FUNCTIONS.buy,
      BCL_FUNCTIONS.sell,
      BCL_FUNCTIONS.create_community,
    ];

    return [
      {
        predicate: (tx: Partial<Tx>) => {
          return (
            tx.type === 'ContractCallTx' &&
            !!tx.contract_id &&
            (contractIds.includes(tx.contract_id as any) ||
              (!!tx.function && functions.includes(tx.function)))
          );
        },
      },
    ];
  }

  protected getSyncService(): BclPluginSyncService {
    return this.bclPluginSyncService;
  }

  /**
   * Handle reorg or invalid transactions by cleaning up related Transaction records
   */
  async onReorg(removedTxHashes: string[]): Promise<void> {
    if (removedTxHashes.length === 0) {
      return;
    }

    this.logger.log(
      `[${this.name}] Cleaning up ${removedTxHashes.length} removed transactions`,
    );

    try {
      // Delete related Transaction records
      const deleted = await this.transactionRepository
        .createQueryBuilder()
        .delete()
        .where('tx_hash IN (:...hashes)', { hashes: removedTxHashes })
        .execute();

      this.logger.log(
        `[${this.name}] Deleted ${deleted.affected || 0} Transaction records for removed transactions`,
      );

      // Note: Tx entities are already deleted by BlockValidationService
      // We only clean up plugin-specific data (Transaction records)
    } catch (error: any) {
      this.logger.error(
        `[${this.name}] Failed to clean up removed transactions`,
        error,
      );
    }
  }

  /**
   * Get queries to retrieve transactions that need auto-updating.
   * Default implementation extracts contract IDs from filters and creates a query.
   * Plugins can override this method to provide custom queries.
   * @param pluginName - The plugin name
   * @param currentVersion - The current plugin version
   * @returns Array of query functions that return transactions needing updates
   */
  getUpdateQueries(
    pluginName: string,
    currentVersion: number,
  ): Array<
    (
      repository: Repository<Tx>,
      limit: number,
      cursor?: TxPageCursor,
    ) => Promise<Tx[]>
  > {
    const supportedFunctions = Object.values(BCL_CONTRACT.FUNCTIONS);

    return [
      async (repo, limit, cursor) => {
        const query = repo
          .createQueryBuilder('tx')
          .where('tx.function IN (:...supportedFunctions)', {
            supportedFunctions,
          })
          // Tests `logs`, not `data`: this plugin only implements `decodeLogs`,
          // so `data->'bcl'` has no writer and the row would match again on
          // every sweep forever -- 873k transactions re-read per restart,
          // retiring none of them.
          .andWhere(
            `(tx.logs->>'${pluginName}' IS NULL OR (tx.logs->'${pluginName}'->>'_version')::int != :version)`,
            { version: currentVersion },
          );

        // Keyset pagination. Must stay a row constructor: the equivalent
        // OR chain cannot give the planner an index lower bound, so the scan
        // restarts at the start of the index and discards every row before
        // the cursor -- measured at 596ms/page 600k rows deep, against 1.2ms
        // for this form at the same cursor.
        if (cursor) {
          query.andWhere(
            '(tx.block_height, tx.micro_time, tx.hash) > (CAST(:cursorHeight AS int), CAST(:cursorMicroTime AS bigint), CAST(:cursorHash AS text))',
            {
              cursorHeight: cursor.block_height,
              cursorMicroTime: cursor.micro_time,
              cursorHash: cursor.hash,
            },
          );
        }

        return query
          .orderBy('tx.block_height', 'ASC')
          .addOrderBy('tx.micro_time', 'ASC')
          .addOrderBy('tx.hash', 'ASC')
          .take(limit)
          .getMany();
      },
    ];
  }
}
