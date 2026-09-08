import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import {
  Plugin,
  PluginBatchResult,
  PluginFilter,
  SyncDirection,
  TxPageCursor,
} from './plugin.interface';
import { BasePluginSyncService } from './base-plugin-sync.service';
import { sanitizeJsonForPostgres } from '@/utils/common';

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
   * One page of the auto-update sweep, walked by `TxPageCursor`. `field` must be
   * one the plugin's decode actually writes: rows it never stamps stay stale and
   * come back on every sweep.
   */
  protected buildUpdateQueryPage(
    repository: Repository<Tx>,
    field: 'logs' | 'data',
    functions: string[],
    currentVersion: number,
    limit: number,
    cursor?: TxPageCursor,
  ): Promise<Tx[]> {
    const query = repository
      .createQueryBuilder('tx')
      .where('tx.function IN (:...supportedFunctions)', {
        supportedFunctions: functions,
      })
      .andWhere(
        `(tx.${field}->>'${this.name}' IS NULL OR (tx.${field}->'${this.name}'->>'_version')::int != :version)`,
        { version: currentVersion },
      );

    // Row constructor, not an OR chain -- see `TxPageCursor`.
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
  }

  /** Defaults to none: a plugin storing no decoded output has nothing to refresh. */
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
    void pluginName;
    void currentVersion;
    return [];
  }

  /**
   * Process a batch of transactions. Delegates to sync service.
   * @param txs - Transactions to process
   * @param syncDirection - 'backward' for historical sync, 'live' for real-time sync, 'reorg' for reorg processing
   */
  async processBatch(
    txs: Tx[],
    syncDirection: SyncDirection,
  ): Promise<PluginBatchResult> {
    if (txs.length === 0) {
      return { failed: [] };
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
              data: decodedLogs,
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
              data: decodedData,
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

    // Process transactions with decoded data, propagating per-tx failures so
    // the caller can park them for retry rather than advancing past lost data.
    return syncService.processBatch(updatedTxs, syncDirection);
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
   * Check if a transaction needs re-decoding based on version mismatch
   * @param tx - Transaction to check
   * @returns Object indicating what needs re-decoding (logs and/or data)
   */
  private needsReDecode(tx: Tx): { logs: boolean; data: boolean } {
    const pluginName = this.name;
    const currentVersion = this.version;

    const logsNeedsReDecode =
      !tx.logs?.[pluginName] ||
      tx.logs[pluginName]?._version !== currentVersion;

    const dataNeedsReDecode =
      !tx.data?.[pluginName] ||
      tx.data[pluginName]?._version !== currentVersion;

    return {
      logs: logsNeedsReDecode,
      data: dataNeedsReDecode,
    };
  }

  /**
   * Update transactions that have version mismatches or missing plugin data.
   * Processes transactions in batches with pagination.
   * @param batchSize - Number of transactions to process per batch (default: 100)
   */
  async updateTransactions(batchSize: number = 100): Promise<void> {
    this.logger.log(`[${this.name}] Starting update transactions`);

    try {
      const queries = this.getUpdateQueries(this.name, this.version);

      if (queries.length === 0) {
        this.logger.log(`[${this.name}] No update queries defined`);
        return;
      }

      const syncService = this.getSyncService();
      let totalProcessed = 0;
      let totalUpdated = 0;

      // Process each query
      for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
        const query = queries[queryIndex];
        let cursor: TxPageCursor | undefined = undefined;
        let hasMore = true;

        this.logger.log(
          `[${this.name}] Processing query ${queryIndex + 1}/${queries.length}`,
        );

        while (hasMore) {
          try {
            // Execute query with cursor-based pagination
            this.logger.debug(
              `[${this.name}] Query ${queryIndex + 1}: Fetching batch with cursor ${cursor ? `(height: ${cursor.block_height}, micro_time: ${cursor.micro_time})` : '(none)'}, limit ${batchSize}`,
            );
            const transactions = await query(
              this.txRepository,
              batchSize,
              cursor,
            );

            if (transactions.length === 0) {
              this.logger.debug(
                `[${this.name}] Query ${queryIndex + 1}: No more transactions`,
              );
              hasMore = false;
              break;
            }

            this.logger.debug(
              `[${this.name}] Query ${queryIndex + 1}: Fetched ${transactions.length} transactions`,
            );

            // Process each transaction in the batch
            let lastTx: Tx | null = null;
            for (const tx of transactions) {
              try {
                const needsReDecode = this.needsReDecode(tx);
                let wasUpdated = false;

                // Update logs if needed
                if (needsReDecode.logs) {
                  try {
                    const decodedLogs = await syncService.decodeLogs(tx);
                    if (decodedLogs !== null) {
                      const currentLogs = tx.logs || {};
                      // Sanitize decoded logs to remove null bytes before saving
                      const sanitizedLogs = sanitizeJsonForPostgres({
                        ...currentLogs,
                        [this.name]: {
                          _version: this.version,
                          data: decodedLogs,
                        },
                      });
                      tx.logs = sanitizedLogs;
                      await this.txRepository.save(tx);
                      wasUpdated = true;
                    }
                  } catch (error: any) {
                    this.logger.error(
                      `[${this.name}] Failed to update logs for transaction ${tx.hash}`,
                      error.stack,
                    );
                  }
                }

                // Update data if needed (after logs are saved)
                if (needsReDecode.data) {
                  try {
                    const decodedData = await syncService.decodeData(tx);
                    if (decodedData !== null) {
                      const currentData = tx.data || {};
                      // Sanitize decoded data to remove null bytes before saving
                      const sanitizedData = sanitizeJsonForPostgres({
                        ...currentData,
                        [this.name]: {
                          _version: this.version,
                          data: decodedData,
                        },
                      });
                      tx.data = sanitizedData;
                      await this.txRepository.save(tx);
                      wasUpdated = true;
                    }
                  } catch (error: any) {
                    this.logger.error(
                      `[${this.name}] Failed to update data for transaction ${tx.hash}`,
                      error.stack,
                    );
                  }
                }

                totalProcessed++;
                if (wasUpdated) {
                  totalUpdated++;
                }

                // Track the last transaction for cursor-based pagination
                // Even if the transaction was updated, we still use it as the cursor
                // because we've already processed it
                lastTx = tx;

                // Log progress periodically
                if (totalProcessed % 100 === 0) {
                  this.logger.log(
                    `[${this.name}] Processed ${totalProcessed} transactions, updated ${totalUpdated}`,
                  );
                }
              } catch (error: any) {
                this.logger.error(
                  `[${this.name}] Failed to process transaction ${tx.hash} during update`,
                  error.stack,
                );
                totalProcessed++;
                // Still track last transaction even on error for cursor
                lastTx = tx;
              }
            }

            // Update cursor for next iteration using the last transaction
            // This ensures we don't skip transactions even if some were updated
            if (lastTx) {
              cursor = {
                block_height: lastTx.block_height,
                micro_time: lastTx.micro_time,
                hash: lastTx.hash,
              };
              this.logger.debug(
                `[${this.name}] Query ${queryIndex + 1}: Updated cursor to (height: ${cursor.block_height}, micro_time: ${cursor.micro_time})`,
              );
            }

            // Check if we should continue pagination
            if (transactions.length < batchSize) {
              this.logger.debug(
                `[${this.name}] Query ${queryIndex + 1}: Last page reached (${transactions.length} < ${batchSize})`,
              );
              hasMore = false;
            }
          } catch (error: any) {
            this.logger.error(
              `[${this.name}] Failed to execute update query ${queryIndex + 1}`,
              error.stack,
            );
            hasMore = false; // Move to next query
          }
        }
      }

      this.logger.log(
        `[${this.name}] Update completed. Processed ${totalProcessed} transactions, updated ${totalUpdated}`,
      );
    } catch (error: any) {
      this.logger.error(
        `[${this.name}] Update transactions failed`,
        error.stack,
      );
    }
  }
}
