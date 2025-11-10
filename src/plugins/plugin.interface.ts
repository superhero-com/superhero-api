import { Tx } from '@/mdw-sync/entities/tx.entity';
import { SyncDirection, SyncDirectionEnum } from '@/mdw-sync/types/sync-direction';

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
}

