import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BasePlugin } from '@/plugins/base-plugin';
import { PluginFilter } from '@/plugins/plugin.interface';
import { BCL_FACTORY } from '@/configs/contracts';
import { ACTIVE_NETWORK } from '@/configs/network';
import { BalanceIndexerService } from '../services/balance-indexer.service';
import { ReorgEvictionService } from '../services/reorg-eviction.service';
import {
  Aex9TransferSyncService,
  AEX9_TRANSFER_PLUGIN_NAME,
  AEX9_TRANSFER_PLUGIN_VERSION,
} from './aex9-transfer-sync.service';

/**
 * Indexer plugin (MAIN mode only) that indexes AEX9 `Transfer` events for
 * community tokens into the `token_balance` ledger (plan §5.3/§5.4). It closes the
 * gap where `TokenHolderService` only tracks BCL buy/sell — any plain AEX9
 * transfer, DEX swap, or airdrop is now reflected in the authoritative raw-balance
 * table that token gating (Task 06) reads.
 *
 * The filter is a single **predicate** mirroring `BclPlugin`: gate on
 * `ContractCallTx` whose `contract_id` is in the community-token allowlist
 * (`BalanceIndexerService.isCommunityToken`). The `Transfer`-event check itself is
 * done at decode time in the sync service (not every call on the token is a
 * transfer).
 *
 * Reorg (Task 11 §6): precise per-tx balance rollback stays out of scope (the
 * reverted txs are already deleted and balances were applied additively → drift is
 * self-healed by the AEX9 reconciliation sweep + eligibility recompute). What this
 * plugin DOES do on reorg is hand any at-risk membership rows (published, now
 * `eligible=false`, non-admin) to {@link ReorgEvictionService.bufferAllPendingEvictions}
 * so a balance drop from a not-yet-confirmed block does NOT evict a member from
 * `39002` prematurely — the worker's scheduled flush publishes the `9001` only once
 * the reorg depth has passed (plan §6.5).
 */
@Injectable()
export class Aex9TransferPlugin extends BasePlugin {
  protected readonly logger = new Logger(Aex9TransferPlugin.name);
  readonly name = AEX9_TRANSFER_PLUGIN_NAME;
  readonly version = AEX9_TRANSFER_PLUGIN_VERSION;

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private readonly balanceIndexer: BalanceIndexerService,
    private readonly aex9TransferSyncService: Aex9TransferSyncService,
    private readonly reorgEviction: ReorgEvictionService,
  ) {
    super();
  }

  /**
   * Earliest relevant height: the BCL factory deploy height (community tokens
   * cannot predate it), the same source `BclPlugin.startFromHeight` uses.
   */
  startFromHeight(): number {
    const networkId = ACTIVE_NETWORK.networkId;
    return BCL_FACTORY[networkId]?.deployed_at_block_height ?? 0;
  }

  filters(): PluginFilter[] {
    return [
      {
        predicate: (tx) =>
          tx.type === 'ContractCallTx' &&
          !!tx.contract_id &&
          this.balanceIndexer.isCommunityToken(tx.contract_id),
      },
    ];
  }

  protected getSyncService(): Aex9TransferSyncService {
    return this.aex9TransferSyncService;
  }

  /**
   * Reorg-gated eviction buffering (Task 11 §6). Precise balance rollback is out of
   * scope (deferred to the reconciliation sweep); what we MUST do here is ensure a
   * balance drop caused by a reverted block does not evict a member from `39002`
   * before the reorg depth confirms — so we buffer every currently at-risk
   * membership (drift-bounded, not registry-wide). The flush (worker) publishes the
   * `9001` only after `TG_REORG_CONFIRMATION_DEPTH_BLOCKS`, and cancels it if the
   * member becomes eligible again. An empty `removedTxHashes` is a no-op.
   */
  async onReorg(removedTxHashes: string[]): Promise<void> {
    if (!removedTxHashes || removedTxHashes.length === 0) {
      return;
    }
    try {
      const buffered = await this.reorgEviction.bufferAllPendingEvictions();
      this.logger.log(
        `[${this.name}] reorg: buffered ${buffered} at-risk eviction(s) ` +
          `(${removedTxHashes.length} removed tx(s))`,
      );
    } catch (error: any) {
      this.logger.error(
        `[${this.name}] reorg: bufferAllPendingEvictions failed: ${error?.message ?? error}`,
      );
    }
  }
}
