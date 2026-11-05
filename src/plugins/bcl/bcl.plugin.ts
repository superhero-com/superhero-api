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
import {
  decrementTradeEligibilityCount,
  TRADE_ELIGIBLE_TX_TYPES,
} from './utils/trade-eligibility.util';
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

    let removed: Array<{
      address: string | null;
      sale_address: string | null;
      tx_type: string;
    }>;
    try {
      // Delete related Transaction records
      const deleted = await this.transactionRepository
        .createQueryBuilder()
        .delete()
        .where('tx_hash IN (:...hashes)', { hashes: removedTxHashes })
        .returning('address, sale_address, tx_type')
        .execute();

      this.logger.log(
        `[${this.name}] Deleted ${deleted.affected || 0} Transaction records for removed transactions`,
      );
      removed = deleted.raw ?? [];

      // Note: Tx entities are already deleted by BlockValidationService
      // We only clean up plugin-specific data (Transaction records)
    } catch (error: any) {
      // The tx rows are gone, so nothing retries this; the hashes let an
      // operator replay the cleanup by hand.
      this.logger.error(
        `[${this.name}] Failed to clean up removed transactions ${removedTxHashes.join(', ')}`,
        error,
      );
      return;
    }

    // Account totals are aggregated from `transactions`, so without this the
    // traders would keep counting the deleted trades until they trade again.
    const traders = new Set(
      removed
        .map((row) => row.address)
        .filter((address): address is string => !!address),
    );
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

    // Same for the token counters, which only move on the token's next trade.
    const removedTradesBySale = new Map<string, number>();
    for (const row of removed) {
      if (!row.sale_address) {
        continue;
      }
      const trade = TRADE_ELIGIBLE_TX_TYPES.has(row.tx_type) ? 1 : 0;
      removedTradesBySale.set(
        row.sale_address,
        (removedTradesBySale.get(row.sale_address) ?? 0) + trade,
      );
    }
    for (const [saleAddress, removedTrades] of removedTradesBySale) {
      try {
        await this.refreshTokenCounters(saleAddress, removedTrades);
      } catch (error: any) {
        this.logger.error(
          `[${this.name}] Failed to refresh token counters for ${saleAddress} after reorg`,
          error,
        );
      }
    }
  }

  private async refreshTokenCounters(
    saleAddress: string,
    removedTrades: number,
  ): Promise<void> {
    // The count TransactionPersistenceService stores after each trade.
    await this.transactionRepository.query(
      `UPDATE token
       SET tx_count = c.n, last_sync_tx_count = c.n
       FROM (SELECT COUNT(*)::int AS n FROM transactions WHERE sale_address = $1) c
       WHERE token.sale_address = $1`,
      [saleAddress],
    );
    if (removedTrades > 0) {
      await decrementTradeEligibilityCount(
        saleAddress,
        removedTrades,
        this.transactionRepository.manager,
      );
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
