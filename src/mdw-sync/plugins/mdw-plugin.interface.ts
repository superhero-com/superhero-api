import { Tx } from '../entities/tx.entity';

export { Tx };

export interface MdwPluginFilter {
  type?: 'contract_call' | 'spend';
  contractIds?: string[];
  functions?: string[];
  predicate?: (tx: Partial<Tx>) => boolean;
}

export interface MdwPlugin {
  name: string;
  startFromHeight(): number;
  filters(): MdwPluginFilter[];
  onTransactionsSaved(txs: Partial<Tx>[]): Promise<void>;
  onReorg?(rollBackToHeight: number): Promise<void>;
}
