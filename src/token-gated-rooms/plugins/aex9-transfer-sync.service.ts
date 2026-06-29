import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BigNumber } from 'bignumber.js';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Encoded } from '@aeternity/aepp-sdk';
import { serializeBigInts } from '@/utils/common';
import { BasePluginSyncService } from '@/plugins/base-plugin-sync.service';
import { SyncDirection } from '@/plugins/plugin.interface';
import { BalanceIndexerService } from '../services/balance-indexer.service';
import FungibleTokenFullACI from './aci/FungibleTokenFull.aci.json';

/** Plugin name — must match `Aex9TransferPlugin.name` (the `tx.logs[...]` key). */
export const AEX9_TRANSFER_PLUGIN_NAME = 'aex9-transfer';
/** Plugin version — bump to force a full re-decode of indexed transfers. */
export const AEX9_TRANSFER_PLUGIN_VERSION = 1;

/** A decoded AEX9 event as returned by `$decodeEvents` + `serializeBigInts`. */
interface DecodedAex9Event {
  name: string;
  args: unknown[];
}

/**
 * Decodes AEX9 `Transfer` events from `tx.raw.log` and applies the balance
 * deltas to `token_balance` in **raw integer base units** (plan §5.4). `Allowance`
 * (and every non-`Transfer` event) is dropped — only `Transfer` moves balances
 * (mirrors the bot's `decodeAex9Events`).
 *
 * Idempotency: the decoded transfers are persisted onto `tx.logs[name]` by
 * `BasePlugin` with a `_version` stamp. We only mutate balances once per tx — the
 * first time the tx is seen at the current plugin version (`tx.logs[name] === undefined`
 * pre-`processBatch`). On a re-process (live + backfill both touch a tx, or a
 * version bump) the legs are decoded again but NOT re-applied, so a transfer is
 * counted exactly once.
 */
@Injectable()
export class Aex9TransferSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(Aex9TransferSyncService.name);

  constructor(
    aeSdkService: AeSdkService,
    private readonly balanceIndexer: BalanceIndexerService,
    @InjectRepository(Tx)
    private readonly txRepository: Repository<Tx>,
  ) {
    super(aeSdkService);
  }

  /**
   * Decode logs from `tx.raw.log` with the AEX9 ACI, keeping only `Transfer`
   * events. Returns the decoded array (stored on `tx.logs[name]` by BasePlugin)
   * or `null` when there is nothing to decode. The contract instance is keyed by
   * `tx.contract_id` (the AEX9 token) so each token gets its own cached decoder.
   */
  async decodeLogs(tx: Tx): Promise<DecodedAex9Event[] | null> {
    if (!tx?.raw?.log || !tx.contract_id) {
      return null;
    }
    try {
      const contract = await this.getContract(
        tx.contract_id as Encoded.ContractAddress,
        FungibleTokenFullACI,
      );
      const decoded = contract.$decodeEvents(tx.raw.log, {
        omitUnknown: true,
      });
      const transfers = (
        serializeBigInts(decoded) as DecodedAex9Event[]
      ).filter((event) => event?.name === 'Transfer');
      return transfers.length > 0 ? transfers : null;
    } catch (error: any) {
      const isUnknownEventError =
        error?.name === 'MissingEventDefinitionError' ||
        error?.message?.includes("Can't find definition");
      if (isUnknownEventError) {
        this.logger.warn(
          `Failed to decode AEX9 logs for tx ${tx.hash} due to unknown event definition`,
        );
      } else {
        this.logger.error(
          `Failed to decode AEX9 logs for tx ${tx.hash}`,
          error.stack,
        );
      }
      return null;
    }
  }

  /**
   * Apply a single tx's decoded `Transfer` legs to `token_balance`. Idempotent:
   * `alreadyApplied` short-circuits a re-process so live+backfill (or a version
   * re-decode) never double-counts. Emits `tgr.balance.changed` for each holder
   * whose persisted balance actually changed.
   */
  async processTransaction(
    tx: Tx,
    _syncDirection: SyncDirection,
  ): Promise<void> {
    void _syncDirection;
    if (!tx.contract_id) {
      return;
    }
    // Defense in depth: the predicate already gated on the allowlist, but a
    // re-decode/backfill path could feed a tx for a token no longer indexed.
    if (!this.balanceIndexer.isCommunityToken(tx.contract_id)) {
      return;
    }
    if (this.alreadyApplied(tx)) {
      return;
    }

    const transfers = this.extractTransfers(tx);
    if (transfers.length === 0) {
      await this.markApplied(tx);
      return;
    }

    const tokenAddress = tx.contract_id;
    const height = tx.block_height ?? 0;
    const changedHolders = new Set<string>();

    for (const transfer of transfers) {
      const [from, to, rawValue] = transfer.args as [string, string, string];
      let value: BigNumber;
      try {
        value = new BigNumber(rawValue as any);
      } catch {
        continue;
      }
      if (!value.isFinite() || value.lte(0)) {
        continue;
      }

      if (from) {
        const next = await this.balanceIndexer.applyDelta(
          tokenAddress,
          from,
          value.negated(),
          height,
        );
        if (next !== null) {
          changedHolders.add(from);
        }
      }
      if (to) {
        const next = await this.balanceIndexer.applyDelta(
          tokenAddress,
          to,
          value,
          height,
        );
        if (next !== null) {
          changedHolders.add(to);
        }
      }
    }

    await this.markApplied(tx);

    for (const holder of changedHolders) {
      this.balanceIndexer.emitBalanceChanged(tokenAddress, holder);
    }
  }

  /**
   * Read the `Transfer` legs for a tx from the persisted decoded version on
   * `tx.logs[name]` (written by `BasePlugin.processBatch`/`syncHistoricalTransactions`
   * via `decodeLogs` BEFORE `processTransaction` runs). Returns `[]` when there is
   * no decoded payload — there is nothing to apply. Already filtered to `Transfer`
   * at decode time; filtered again here defensively.
   */
  private extractTransfers(tx: Tx): DecodedAex9Event[] {
    const persisted = tx.logs?.[AEX9_TRANSFER_PLUGIN_NAME]?.data as
      | DecodedAex9Event[]
      | undefined;
    if (Array.isArray(persisted)) {
      return persisted.filter((event) => event?.name === 'Transfer');
    }
    return [];
  }

  /**
   * Idempotency guard. A tx whose balance legs were already applied carries an
   * `_applied: true` marker (set by `markApplied`, persisted via the data merge
   * BasePlugin saves). Returns true when the tx must NOT be re-applied.
   */
  private alreadyApplied(tx: Tx): boolean {
    return tx.data?.[AEX9_TRANSFER_PLUGIN_NAME]?.data?._applied === true;
  }

  /**
   * Mark the tx as balance-applied and **persist** it, so a later re-process
   * (live↔backfill overlap, version re-decode, or restart) is a no-op. BasePlugin
   * also stamps `_version`; here we set the `_applied` flag the guard reads. The
   * write is guarded so a persistence failure does not crash the batch (the
   * balance legs already committed; worst case a future re-process re-applies and
   * is caught by the clamp/equality no-op).
   */
  private async markApplied(tx: Tx): Promise<void> {
    const current = tx.data || {};
    const existing = current[AEX9_TRANSFER_PLUGIN_NAME]?.data || {};
    tx.data = {
      ...current,
      [AEX9_TRANSFER_PLUGIN_NAME]: {
        _version: AEX9_TRANSFER_PLUGIN_VERSION,
        data: { ...existing, _applied: true },
      },
    };
    try {
      await this.txRepository.update({ hash: tx.hash }, { data: tx.data });
    } catch (error: any) {
      this.logger.warn(
        `Failed to persist _applied marker for tx ${tx.hash}; idempotency relies on the in-memory flag for this run`,
        error,
      );
    }
  }
}
