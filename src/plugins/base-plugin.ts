import { Logger } from '@nestjs/common';
import { Repository, MoreThan } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { Plugin, PluginFilter, SyncDirection, SyncDirectionEnum } from './plugin.interface';
import { BasePluginSyncService } from './base-plugin-sync.service';

export abstract class BasePlugin implements Plugin {
  protected abstract readonly logger: Logger;
  protected abstract readonly txRepository: Repository<Tx>;
  protected abstract readonly pluginSyncStateRepository: Repository<PluginSyncState>;

  abstract readonly name: string;
  abstract readonly version: number;
  abstract startFromHeight(): number;
  abstract filters(): PluginFilter[];

  /**
   * Returns the sync service for processing transactions
   */
  protected abstract getSyncService(): BasePluginSyncService;

  /**
   * Process a batch of transactions. Delegates to sync service.
   * @param txs - Transactions to process
   * @param syncDirection - 'backward' for historical sync, 'live' for real-time sync, 'reorg' for reorg processing
   */
  async processBatch(txs: Tx[], syncDirection: SyncDirection): Promise<void> {
    if (txs.length === 0) {
      return;
    }

    const syncService = this.getSyncService();
    const updatedTxs: Tx[] = [];

    // Decode logs and data for each transaction before processing
    for (const tx of txs) {
      try {
        // Step 1: Decode logs
        const decodedLogs = await syncService.decodeLogs(tx);
        if (decodedLogs !== null) {
          // Merge decoded logs into tx.logs
          const currentLogs = tx.logs || {};
          tx.logs = {
            ...currentLogs,
            [this.name]: {
              _version: this.version,
              ...decodedLogs,
            },
          };

          // Save transaction with updated logs
          await this.txRepository.save(tx);
        }

        // Step 2: Decode data (after logs are saved)
        const decodedData = await syncService.decodeData(tx);
        if (decodedData !== null) {
          // Merge decoded data into tx.data
          const currentData = tx.data || {};
          tx.data = {
            ...currentData,
            [this.name]: {
              _version: this.version,
              ...decodedData,
            },
          };

          // Save transaction with updated data
          await this.txRepository.save(tx);
        }

        updatedTxs.push(tx);
      } catch (error: any) {
        // Log error but continue processing - decoding errors don't block processing
        this.logger.error(
          `[${this.name}] Failed to decode logs/data for transaction ${tx.hash}`,
          error.stack,
        );
        // Still add tx to updatedTxs so processTransaction can be called
        updatedTxs.push(tx);
      }
    }

    // Process transactions with decoded data
    await syncService.processBatch(updatedTxs, syncDirection);
  }

  /**
   * Handle reorg by receiving list of removed transaction hashes.
   * Also used for invalid transactions detected during verification.
   * Default implementation logs the removed transactions.
   * Plugins can override for custom cleanup.
   * Note: Transactions have already been deleted from the database at this point.
   */
  async onReorg(removedTxHashes: string[]): Promise<void> {
    this.logger.log(
      `[${this.name}] Transactions removed (reorg or invalid): ${removedTxHashes.length} transactions`,
    );
    // Plugins should override this method to handle cleanup of their own data
    // The sync state will be updated by the reorg service
  }

  /**
   * Sync historical transactions from the database
   */
  async syncHistoricalTransactions(): Promise<void> {
    this.logger.log(`[${this.name}] Starting historical transaction sync`);

    try {
      // Get plugin sync state
      const syncState = await this.pluginSyncStateRepository.findOne({
        where: { plugin_name: this.name },
      });

      if (!syncState) {
        this.logger.warn(
          `[${this.name}] Plugin sync state not found`,
        );
        return;
      }

      // Use backward_synced_height if available, otherwise fall back to last_synced_height
      const syncedHeight = syncState.backward_synced_height ?? syncState.last_synced_height ?? syncState.start_from_height - 1;
      const startHeight = syncedHeight + 1;
      const batchSize = 100;
      let processedCount = 0;

      this.logger.log(`[${this.name}] Syncing from height ${startHeight}`);

      let hasMore = true;
      let currentOffset = 0;

      while (hasMore) {
        // Fetch batch of transactions
        const transactions = await this.fetchTransactionBatch(
          startHeight,
          batchSize,
          currentOffset,
        );

        if (transactions.length === 0) {
          hasMore = false;
          break;
        }

        // Process each transaction
        const syncService = this.getSyncService();
        for (const tx of transactions) {
          try {
            // Decode logs and data before processing
            try {
              // Step 1: Decode logs
              const decodedLogs = await syncService.decodeLogs(tx);
              if (decodedLogs !== null) {
                const currentLogs = tx.logs || {};
                tx.logs = {
                  ...currentLogs,
                  [this.name]: {
                    _version: this.version,
                    ...decodedLogs,
                  },
                };
                await this.txRepository.save(tx);
              }

              // Step 2: Decode data (after logs are saved)
              const decodedData = await syncService.decodeData(tx);
              if (decodedData !== null) {
                const currentData = tx.data || {};
                tx.data = {
                  ...currentData,
                  [this.name]: {
                    _version: this.version,
                    ...decodedData,
                  },
                };
                await this.txRepository.save(tx);
              }
            } catch (decodeError: any) {
              // Log decode error but continue processing
              this.logger.error(
                `[${this.name}] Failed to decode logs/data for transaction ${tx.hash}`,
                decodeError.stack,
              );
            }

            await syncService.processTransaction(tx, SyncDirectionEnum.Backward);
            processedCount++;

            // Update sync state periodically
            if (processedCount % 10 === 0) {
              await this.pluginSyncStateRepository.update(
                { plugin_name: this.name },
                { 
                  last_synced_height: tx.block_height, // Keep for backward compatibility
                  backward_synced_height: tx.block_height,
                },
              );
            }
          } catch (error: any) {
            this.logger.error(
              `[${this.name}] Failed to process transaction ${tx.hash}`,
              error.stack,
            );
          }
        }

        currentOffset += batchSize;

        // Check if we should continue
        if (transactions.length < batchSize) {
          hasMore = false;
        }
      }

      this.logger.log(
        `[${this.name}] Historical sync completed. Processed ${processedCount} transactions`,
      );
    } catch (error: any) {
      this.logger.error(`[${this.name}] Historical sync failed`, error.stack);
    }
  }

  /**
   * Fetch a batch of transactions that match the plugin's filters
   */
  private async fetchTransactionBatch(
    startHeight: number,
    limit: number,
    offset: number,
  ): Promise<Tx[]> {
    const filters = this.filters();
    const query = this.txRepository
      .createQueryBuilder('tx')
      .where('tx.block_height >= :startHeight', { startHeight })
      .orderBy('tx.block_height', 'ASC')
      .addOrderBy('tx.micro_time', 'ASC')
      .skip(offset)
      .take(limit);

    // Build WHERE conditions based on filters
    const contractIds: string[] = [];
    const functions: string[] = [];
    let hasSpendFilter = false;
    let hasContractCallFilter = false;

    for (const filter of filters) {
      if (filter.type === 'spend') {
        hasSpendFilter = true;
      }
      if (filter.type === 'contract_call') {
        hasContractCallFilter = true;
      }
      if (filter.contractIds) {
        contractIds.push(...filter.contractIds);
      }
      if (filter.functions) {
        functions.push(...filter.functions);
      }
    }

    // Apply type filters
    if (hasSpendFilter && !hasContractCallFilter) {
      query.andWhere('tx.type = :type', { type: 'SpendTx' });
    } else if (hasContractCallFilter && !hasSpendFilter) {
      query.andWhere('tx.type = :type', { type: 'ContractCallTx' });
    }

    // Apply contract ID filter
    if (contractIds.length > 0) {
      query.andWhere('tx.contract_id IN (:...contractIds)', { contractIds });
    }

    // Apply function filter
    if (functions.length > 0) {
      query.andWhere('tx.function IN (:...functions)', { functions });
    }

    const transactions = await query.getMany();

    // If we have predicate filters, we need to filter in memory
    const hasPredicateFilters = filters.some((f) => f.predicate);
    if (hasPredicateFilters) {
      const syncService = this.getSyncService();
      return transactions.filter((tx) =>
        filters.some((filter) =>
          (syncService as any).matchesFilter(tx, filter),
        ),
      );
    }

    return transactions;
  }
}

