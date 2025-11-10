import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '../entities/tx.entity';
import { PluginSyncState } from '../entities/plugin-sync-state.entity';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginFailedTransactionService } from './plugin-failed-transaction.service';
import { Plugin, SyncDirection } from '@/plugins/plugin.interface';
import { SyncDirectionEnum } from '../types/sync-direction';
import { BasePluginSyncService } from '@/plugins/base-plugin-sync.service';

@Injectable()
export class PluginBatchProcessorService {
  private readonly logger = new Logger(PluginBatchProcessorService.name);
  private syncStateCache = new Map<string, PluginSyncState | null>();

  constructor(
    private pluginRegistryService: PluginRegistryService,
    private failedTransactionService: PluginFailedTransactionService,
    @InjectRepository(PluginSyncState)
    private pluginSyncStateRepository: Repository<PluginSyncState>,
    private configService: ConfigService,
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
      console.log("================================================")
      console.log("No plugins found");
      console.log("================================================")
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
      console.log("================================================")
      console.log("Matching transactions for plugin", plugin.name, matchingTransactions.length, syncDirection);
      console.log("================================================")
      // Process batch - errors are handled inside processBatch
      try {
        await plugin.processBatch(matchingTransactions, syncDirection);

        // Update sync state with the highest block height processed
        const maxHeight = Math.max(
          ...matchingTransactions.map((tx) => tx.block_height),
        );
        
        // Update appropriate height field based on sync direction
        const updateData: Partial<PluginSyncState> = {
          last_synced_height: maxHeight, // Keep for backward compatibility
        };
        
        if (syncDirection === SyncDirectionEnum.Backward) {
          updateData.backward_synced_height = maxHeight;
        } else if (syncDirection === SyncDirectionEnum.Live) {
          updateData.live_synced_height = maxHeight;
        }
        // Reorg direction doesn't update sync state heights
        
        await this.pluginSyncStateRepository.update(
          { plugin_name: plugin.name },
          updateData,
        );

        this.logger.debug(
          `[${plugin.name}] Processed ${matchingTransactions.length} transactions`,
        );
      } catch (error: any) {
        // If the entire batch fails, record failures for each transaction
        const pluginVersion = syncState.version;
        for (const tx of matchingTransactions) {
          await this.failedTransactionService.recordFailure(
            plugin.name,
            tx,
            error,
            pluginVersion,
          );
        }
        this.logger.error(
          `[${plugin.name}] Failed to process batch of ${matchingTransactions.length} transactions`,
          error,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `[${plugin.name}] Error in processBatchForPlugin`,
        error,
      );
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

