import { Tx } from '../entities/tx.entity';

export { Tx };

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
}
