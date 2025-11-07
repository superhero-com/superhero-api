import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '../entities/tx.entity';
import { PluginSyncState } from '../entities/plugin-sync-state.entity';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginFailedTransactionService } from './plugin-failed-transaction.service';
import { Plugin } from '@/plugins/plugin.interface';
import { BasePluginSyncService } from '@/plugins/base-plugin-sync.service';

@Injectable()
export class PluginBatchProcessorService {
  private readonly logger = new Logger(PluginBatchProcessorService.name);

  constructor(
    private pluginRegistryService: PluginRegistryService,
    private failedTransactionService: PluginFailedTransactionService,
    @InjectRepository(PluginSyncState)
    private pluginSyncStateRepository: Repository<PluginSyncState>,
    private configService: ConfigService,
  ) {}

  /**
   * Process a batch of transactions for all plugins
   */
  async processBatch(transactions: Tx[]): Promise<void> {
    if (transactions.length === 0) {
      return;
    }

    const plugins = this.pluginRegistryService.getPlugins();
    if (plugins.length === 0) {
      return;
    }

    // Process each plugin independently
    const pluginPromises = plugins.map((plugin) =>
      this.processBatchForPlugin(plugin, transactions),
    );

    // Don't wait for all - let them process independently
    await Promise.allSettled(pluginPromises);
  }

  /**
   * Process a batch of transactions for a specific plugin
   */
  private async processBatchForPlugin(
    plugin: Plugin,
    transactions: Tx[],
  ): Promise<void> {
    try {
      // Get plugin sync state
      const syncState = await this.pluginSyncStateRepository.findOne({
        where: { plugin_name: plugin.name },
      });

      if (!syncState || !syncState.is_active) {
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

      // Process batch - errors are handled inside processBatch
      try {
        await plugin.processBatch(matchingTransactions);

        // Update sync state with the highest block height processed
        const maxHeight = Math.max(
          ...matchingTransactions.map((tx) => tx.block_height),
        );
        await this.pluginSyncStateRepository.update(
          { plugin_name: plugin.name },
          { last_synced_height: maxHeight },
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
   */
  private filterTransactionsForPlugin(
    plugin: Plugin,
    transactions: Tx[],
  ): Tx[] {
    const filters = plugin.filters();
    if (filters.length === 0) {
      return [];
    }

    // Get sync service to use filter matching
    // We need to access the sync service through the plugin
    // For now, we'll do basic filtering here and let the plugin do detailed filtering
    const matching: Tx[] = [];

    for (const tx of transactions) {
      // Basic filtering based on contract ID, function, and type
      const matches = filters.some((filter) => {
        // Check type
        if (filter.type) {
          if (filter.type === 'contract_call' && tx.type !== 'ContractCallTx') {
            return false;
          }
          if (filter.type === 'spend' && tx.type !== 'SpendTx') {
            return false;
          }
        }

        // Check contract ID
        if (filter.contractIds && filter.contractIds.length > 0) {
          if (!tx.contract_id || !filter.contractIds.includes(tx.contract_id)) {
            return false;
          }
        }

        // Check function
        if (filter.functions && filter.functions.length > 0) {
          if (!tx.function || !filter.functions.includes(tx.function)) {
            return false;
          }
        }

        // Check predicate if provided
        if (filter.predicate) {
          return filter.predicate(tx);
        }

        return true;
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

