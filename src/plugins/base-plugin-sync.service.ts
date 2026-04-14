import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Contract, Encoded } from '@aeternity/aepp-sdk';
import { Logger } from '@nestjs/common';
import { PluginFilter, SyncDirection } from './plugin.interface';
import { AeSdkService } from '@/ae/ae-sdk.service';

type ContractInstance = Awaited<ReturnType<typeof Contract.initialize>>;

type CachedContract = {
  instance: ContractInstance;
  lastUsedAt: number;
};

export abstract class BasePluginSyncService {
  static readonly MAX_CACHED_CONTRACTS = 150;

  protected abstract readonly logger: Logger;

  private contractCache: Record<Encoded.ContractAddress, CachedContract> = {};

  constructor(protected readonly aeSdkService: AeSdkService) {}

  /**
   * Decode transaction logs from tx.raw.log.
   * Plugins can override this to decode logs specific to their contract.
   * @param tx - Transaction to decode logs from
   * @returns Decoded log data or null if not applicable
   */
  async decodeLogs(tx: Tx): Promise<any | null> {
    void tx;
    return null;
  }

  /**
   * Decode transaction data.
   * Plugins can override this to extract and return plugin-specific data.
   * @param tx - Transaction to decode data from
   * @returns Decoded data or null if not applicable
   */
  async decodeData(tx: Tx): Promise<any | null> {
    void tx;
    return null;
  }

  /**
   * Process a single transaction. Must be implemented by each plugin.
   * @param tx - Transaction to process
   * @param syncDirection - 'backward' for historical sync, 'live' for real-time sync, 'reorg' for reorg processing
   */
  abstract processTransaction(
    tx: Tx,
    syncDirection: SyncDirection,
  ): Promise<void>;

  /**
   * Process a batch of transactions. Default implementation loops through and calls processTransaction.
   * Plugins can override for optimized batch processing.
   * @param txs - Transactions to process
   * @param syncDirection - 'backward' for historical sync, 'live' for real-time sync, 'reorg' for reorg processing
   */
  async processBatch(txs: Tx[], syncDirection: SyncDirection): Promise<void> {
    for (const tx of txs) {
      try {
        await this.processTransaction(tx, syncDirection);
      } catch (error: any) {
        this.handleError(error as Error, tx, 'processBatch');
        // Continue processing other transactions even if one fails
      }
    }
  }

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
    return !!filter.predicate?.(tx);
  }

  /**
   * Handle errors during transaction processing
   */
  protected handleError(error: Error, tx: Tx, context: string): void {
    this.logger.error(
      `${context}: Failed to process transaction ${tx.hash}`,
      error.stack,
    );
  }

  async getContract(
    contractAddress: Encoded.ContractAddress,
    aci: any,
  ): Promise<ContractInstance> {
    const cached = this.contractCache[contractAddress];
    if (cached) {
      cached.lastUsedAt = Date.now();
      return cached.instance;
    }
    const contract = await Contract.initialize({
      ...this.aeSdkService.sdk.getContext(),
      aci,
      address: contractAddress as Encoded.ContractAddress,
    });
    this.contractCache[contractAddress] = {
      instance: contract,
      lastUsedAt: Date.now(),
    };
    this.evictStalestContract();
    return contract;
  }

  private evictStalestContract(): void {
    const keys = Object.keys(this.contractCache);
    if (keys.length <= BasePluginSyncService.MAX_CACHED_CONTRACTS) return;
    let oldestKey = keys[0];
    let oldestTime = this.contractCache[oldestKey]?.lastUsedAt ?? 0;
    for (const key of keys) {
      const t = this.contractCache[key]?.lastUsedAt ?? 0;
      if (t < oldestTime) {
        oldestTime = t;
        oldestKey = key;
      }
    }
    delete this.contractCache[oldestKey];
  }

  getCacheSize(): number {
    return Object.keys(this.contractCache).length;
  }
}
