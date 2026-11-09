import {
  Plugin,
  PluginBatchFailure,
  SyncDirection,
} from '@/plugins/plugin.interface';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PluginSyncState } from '../entities/plugin-sync-state.entity';
import { Tx } from '../entities/tx.entity';
import { SyncDirectionEnum } from '../types/sync-direction';
import { PluginFailedTransactionService } from './plugin-failed-transaction.service';
import { PluginRegistryService } from './plugin-registry.service';

@Injectable()
export class PluginBatchProcessorService {
  private readonly logger = new Logger(PluginBatchProcessorService.name);
  private syncStateCache = new Map<string, PluginSyncState | null>();

  constructor(
    private pluginRegistryService: PluginRegistryService,
    private failedTransactionService: PluginFailedTransactionService,
    @InjectRepository(PluginSyncState)
    private pluginSyncStateRepository: Repository<PluginSyncState>,
  ) {}

  /**
   * Process a batch of transactions for all plugins
   * @param transactions - Transactions to process
   * @param syncDirection - 'backward' for historical sync, 'live' for real-time sync, 'reorg' for reorg processing
   */
  async processBatch(
    transactions: Tx[],
    syncDirection: SyncDirection,
  ): Promise<void> {
    if (transactions.length === 0) {
      return;
    }

    const plugins = this.pluginRegistryService.getPlugins();
    if (plugins.length === 0) {
      return;
    }

    // Process each plugin independently
    const pluginPromises = plugins.map((plugin) =>
      this.processBatchForPlugin(plugin, transactions, syncDirection),
    );

    // Don't wait for all - let them process independently
    await Promise.allSettled(pluginPromises);
  }

  /**
   * Get plugin sync state with caching
   */
  private async getCachedSyncState(
    pluginName: string,
  ): Promise<PluginSyncState | null> {
    // Check cache first
    if (this.syncStateCache.has(pluginName)) {
      return this.syncStateCache.get(pluginName) ?? null;
    }

    // Fetch from database and cache
    const syncState = await this.pluginSyncStateRepository.findOne({
      where: { plugin_name: pluginName },
    });

    // Cache the result (even if null to avoid repeated queries)
    this.syncStateCache.set(pluginName, syncState ?? null);

    return syncState ?? null;
  }

  /**
   * Process a batch of transactions for a specific plugin
   */
  private async processBatchForPlugin(
    plugin: Plugin,
    transactions: Tx[],
    syncDirection: SyncDirection,
  ): Promise<void> {
    try {
      // Get plugin sync state (cached)
      const syncState = await this.getCachedSyncState(plugin.name);

      if (!syncState) {
        return;
      }

      // Filter transactions that match plugin filters
      const matchingTransactions = this.filterTransactionsForPlugin(
        plugin,
        transactions,
      );

      if (matchingTransactions.length === 0) {
        return;
      }

      let failures: PluginBatchFailure[];
      let batchThrew = false;
      try {
        const result = await plugin.processBatch(
          matchingTransactions,
          syncDirection,
        );
        failures = (result && result.failed) || [];
      } catch (error: any) {
        batchThrew = true;
        failures = matchingTransactions.map((tx) => ({ tx, error }));
        this.logger.error(
          `[${plugin.name}] Failed to process batch of ${matchingTransactions.length} transactions`,
          error,
        );
      }

      // Past the validation window nothing re-runs a tx, so these rows are
      // the only way a failure gets processed again (see
      // PluginFailedTransactionService.retryDueFailedTransactions).
      for (const failure of failures) {
        await this.failedTransactionService.recordFailure(
          plugin.name,
          failure.tx,
          failure.error,
          syncState.version,
        );
      }
      if (failures.length > 0 && !batchThrew) {
        this.logger.warn(
          `[${plugin.name}] Parked ${failures.length}/${matchingTransactions.length} failed transactions for retry`,
        );
      }

      // A tx parked earlier may have just gone through (e.g. on a validation
      // re-run); leaving its row would replay it for nothing.
      const failedHashes = new Set(failures.map((failure) => failure.tx.hash));
      await this.failedTransactionService.clearFailures(
        plugin.name,
        matchingTransactions
          .map((tx) => tx.hash)
          .filter((hash) => !failedHashes.has(hash)),
      );

      if (batchThrew) {
        return;
      }
      await this.updateSyncHeights(
        plugin.name,
        matchingTransactions,
        syncDirection,
      );

      this.logger.debug(
        `[${plugin.name}] Processed ${matchingTransactions.length} transactions`,
      );
    } catch (error: any) {
      this.logger.error(
        `[${plugin.name}] Error in processBatchForPlugin`,
        error,
      );
    }
  }

  /**
   * These heights are only reported (MdwController), nothing replays from
   * them, so a failed update is logged rather than parking a processed batch.
   */
  private async updateSyncHeights(
    pluginName: string,
    transactions: Tx[],
    syncDirection: SyncDirection,
  ): Promise<void> {
    const maxHeight = Math.max(...transactions.map((tx) => tx.block_height));

    const updateData: Partial<PluginSyncState> = {
      last_synced_height: maxHeight, // Keep for backward compatibility
    };
    if (syncDirection === SyncDirectionEnum.Backward) {
      updateData.backward_synced_height = maxHeight;
    } else if (syncDirection === SyncDirectionEnum.Live) {
      updateData.live_synced_height = maxHeight;
    }
    // Reorg direction doesn't update sync state heights

    try {
      await this.pluginSyncStateRepository.update(
        { plugin_name: pluginName },
        updateData,
      );
    } catch (error: any) {
      this.logger.error(`[${pluginName}] Failed to update sync heights`, error);
    }
  }

  /**
   * Filter transactions that match a plugin's filters
   * Uses predicate functions only - filters without predicates match nothing
   */
  private filterTransactionsForPlugin(
    plugin: Plugin,
    transactions: Tx[],
  ): Tx[] {
    const filters = plugin.filters();
    if (filters.length === 0) {
      return [];
    }

    const matching: Tx[] = [];

    for (const tx of transactions) {
      // Use OR logic: transaction matches if ANY filter's predicate returns true
      const matches = filters.some((filter) => {
        // Filters without predicates match nothing (return false)
        return !!filter.predicate?.(tx);
      });

      if (matches) {
        matching.push(tx);
      }
    }

    return matching;
  }

  /**
   * Collect predicate functions from all registered plugins' filters.
   * Predicates are used to decide whether a transaction should be indexed at all
   * (i.e. saved to the database) during block/live sync.
   */
  private collectPluginPredicates(): Array<(tx: Partial<Tx>) => boolean> {
    const predicates: Array<(tx: Partial<Tx>) => boolean> = [];

    for (const plugin of this.pluginRegistryService.getPlugins()) {
      for (const filter of plugin.filters()) {
        if (filter.predicate) {
          predicates.push(filter.predicate);
        }
      }
    }

    return predicates;
  }

  /**
   * Return only the transactions that match at least one registered plugin's filter.
   * Transactions that do not match any plugin are considered irrelevant and should
   * not be persisted by the indexer.
   *
   * When there are no predicates registered, this returns an empty array so we do
   * not accidentally index every transaction on the chain.
   */
  filterRelevantTransactions<T extends Partial<Tx>>(transactions: T[]): T[] {
    if (transactions.length === 0) {
      return [];
    }

    const predicates = this.collectPluginPredicates();
    if (predicates.length === 0) {
      return [];
    }

    return transactions.filter((tx) =>
      predicates.some((predicate) => predicate(tx)),
    );
  }

  /**
   * Check whether a single transaction matches at least one registered plugin's filter.
   */
  isRelevantTransaction(tx: Partial<Tx>): boolean {
    const predicates = this.collectPluginPredicates();
    if (predicates.length === 0) {
      return false;
    }
    return predicates.some((predicate) => predicate(tx));
  }

  /**
   * Handle reorg by notifying all plugins
   */
  async handleReorg(removedTxHashes: string[]): Promise<void> {
    if (removedTxHashes.length === 0) {
      return;
    }

    const plugins = this.pluginRegistryService.getPlugins();
    const pluginPromises = plugins.map((plugin) =>
      this.notifyPluginReorg(plugin, removedTxHashes),
    );

    await Promise.allSettled(pluginPromises);
    await this.failedTransactionService.clearFailuresForTxs(removedTxHashes);
  }

  /**
   * Notify a single plugin about reorg
   */
  private async notifyPluginReorg(
    plugin: Plugin,
    removedTxHashes: string[],
  ): Promise<void> {
    try {
      await plugin.onReorg(removedTxHashes);
      this.logger.debug(
        `[${plugin.name}] Notified about reorg with ${removedTxHashes.length} removed transactions`,
      );
    } catch (error: any) {
      this.logger.error(
        `[${plugin.name}] Failed to handle reorg notification`,
        error,
      );
    }
  }
}
