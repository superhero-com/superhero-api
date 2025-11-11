import { Tx } from '@/mdw-sync/entities/tx.entity';
import { SyncDirection, SyncDirectionEnum } from '@/mdw-sync/types/sync-direction';
import { Repository } from 'typeorm';

export { Tx };
export { SyncDirection, SyncDirectionEnum };

export interface PluginFilter {
  type?: 'contract_call' | 'spend';
  contractIds?: string[];
  functions?: string[];
  predicate?: (tx: Partial<Tx>) => boolean;
}

export interface Plugin {
  name: string;
  /**
   * When the plugin version changes, it will cause a full re-sync of the plugin transactions.
   */
  version: number;
  startFromHeight(): number;
  filters(): PluginFilter[];
  syncHistoricalTransactions(): Promise<void>;
  /**
   * Process a batch of transactions. Plugins can override for optimized batch processing.
   * @param txs - Transactions to process
   * @param syncDirection - 'backward' for historical sync, 'live' for real-time sync, 'reorg' for reorg processing
   */
  processBatch(txs: Tx[], syncDirection: SyncDirection): Promise<void>;
  /**
   * Handle reorg by receiving list of removed transaction hashes.
   * Also used for invalid transactions detected during verification.
   * Plugins should clean up any data related to these removed/invalid transactions.
   */
  onReorg(removedTxHashes: string[]): Promise<void>;
  /**
   * Get queries to retrieve transactions that need auto-updating.
   * Each query should filter transactions where plugin data doesn't exist or version doesn't match.
   * @param pluginName - The plugin name
   * @param currentVersion - The current plugin version
   * @returns Array of query functions that return transactions needing updates
   */
  getUpdateQueries(pluginName: string, currentVersion: number): Array<(repository: Repository<Tx>, offset: number, limit: number) => Promise<Tx[]>>;
  /**
   * Update transactions that have version mismatches or missing plugin data.
   * Processes transactions in batches with pagination.
   * @param batchSize - Number of transactions to process per batch (default: 100)
   */
  updateTransactions(batchSize?: number): Promise<void>;
}

