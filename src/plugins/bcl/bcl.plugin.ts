import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { AccountService } from '@/account/services/account.service';
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
    private accountService: AccountService,
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

    let traders: Set<string>;
    try {
      // Delete related Transaction records
      const deleted = await this.transactionRepository
        .createQueryBuilder()
        .delete()
        .where('tx_hash IN (:...hashes)', { hashes: removedTxHashes })
        .returning('address')
        .execute();

      this.logger.log(
        `[${this.name}] Deleted ${deleted.affected || 0} Transaction records for removed transactions`,
      );
      traders = new Set(
        ((deleted.raw ?? []) as Array<{ address: string | null }>)
          .map((row) => row.address)
          .filter((address): address is string => !!address),
      );

      // Note: Tx entities are already deleted by BlockValidationService
      // We only clean up plugin-specific data (Transaction records)
    } catch (error: any) {
      this.logger.error(
        `[${this.name}] Failed to clean up removed transactions`,
        error,
      );
      return;
    }

    // Account totals are aggregated from `transactions`, so without this the
    // traders would keep counting the deleted trades until they trade again.
    for (const address of traders) {
      try {
        await this.accountService.ensureAccountFromTransactions(address);
      } catch (error: any) {
        this.logger.error(
          `[${this.name}] Failed to refresh account totals for ${address} after reorg`,
          error,
        );
      }
    }
  }

  /** Selects on `logs`: this plugin implements only `decodeLogs`. */
  getUpdateQueries(
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
      (repo, limit, cursor) =>
        this.buildUpdateQueryPage(
          repo,
          'logs',
          supportedFunctions,
          currentVersion,
          limit,
          cursor,
        ),
    ];
  }
}
