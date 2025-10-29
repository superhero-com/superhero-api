import { MdwTx } from '../entities/mdw-tx.entity';

export { MdwTx };

export interface MdwPluginFilter {
  type?: 'contract_call' | 'spend';
  contractIds?: string[];
  functions?: string[];
  predicate?: (tx: Partial<MdwTx>) => boolean;
}

export interface MdwPlugin {
  name: string;
  startFromHeight(): number;
  filters(): MdwPluginFilter[];
  onTransactionsSaved(txs: Partial<MdwTx>[]): Promise<void>;
  onReorg?(rollBackToHeight: number): Promise<void>;
}
