import { Logger } from '@nestjs/common';
import { ITransaction } from '@/utils/types';
import { Tx } from '../entities/tx.entity';
import { PluginFilter } from './plugin.interface';

export abstract class BasePluginSyncService {
  protected abstract readonly logger: Logger;

  /**
   * Process a single transaction. Must be implemented by each plugin.
   */
  abstract processTransaction(tx: Tx): Promise<void>;

  /**
   * Check if a transaction matches all provided filters
   */
  protected matchesFilters(tx: Tx, filters: PluginFilter[]): boolean {
    if (!filters || filters.length === 0) {
      return false;
    }

    return filters.some((filter) => this.matchesFilter(tx, filter));
  }

  /**
   * Check if a transaction matches a single filter
   */
  protected matchesFilter(tx: Tx, filter: PluginFilter): boolean {
    const rawTx = tx.raw as ITransaction;

    // Check type
    if (filter.type) {
      const txType = rawTx?.tx?.type;
      if (filter.type === 'contract_call' && txType !== 'ContractCallTx') {
        return false;
      }
      if (filter.type === 'spend' && txType !== 'SpendTx') {
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

    // Check predicate
    if (filter.predicate) {
      return filter.predicate(tx);
    }

    return true;
  }

  /**
   * Handle errors during transaction processing
   */
  protected handleError(error: Error, tx: Tx, context: string): void {
    this.logger.error(
      `${context}: Failed to process transaction ${tx.tx_hash}`,
      error.stack,
    );
  }
}
