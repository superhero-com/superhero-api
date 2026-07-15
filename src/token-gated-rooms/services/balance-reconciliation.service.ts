import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigType } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Queue } from 'bull';
import { BigNumber } from 'bignumber.js';
import { Contract, Encoded } from '@aeternity/aepp-sdk';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { TokenBalance } from '../entities/token-balance.entity';
import { BalanceIndexerService } from './balance-indexer.service';
import tgrConfig from '../config/tgr.config';
import {
  TGR_QUEUE_NAMES,
  TGR_QUEUE_OWNER,
  prefixQueue,
} from '../config/queue-prefix';
import FungibleTokenFullACI from '../plugins/aci/FungibleTokenFull.aci.json';

/** Prefixed Bull queue name for the AEX9 reconciliation sweep (Shared contracts). */
export const RECONCILE_BALANCE_QUEUE = prefixQueue(
  TGR_QUEUE_NAMES.RECONCILE_BALANCE,
  TGR_QUEUE_OWNER[TGR_QUEUE_NAMES.RECONCILE_BALANCE],
);

/** Bull job id used for the single repeatable sweep (so re-adds don't dupe it). */
export const RECONCILE_BALANCE_REPEAT_JOB = 'reconcile-balance-sweep';

/** Cached AEX9 contract instances keyed by token address (reconciliation reads). */
type ContractInstance = Awaited<ReturnType<typeof Contract.initialize>>;

/**
 * Repeatable Bull (v4) consumer on the **`reconcile-balance`** queue (consumed by
 * the indexer/main process per `TGR_QUEUE_OWNER`). Each run sweeps a rotating
 * batch of `token_balance` rows ordered by oldest `last_reconciled_at` (the
 * cursor), re-reads the authoritative AEX9 balance from chain for each
 * `(token_address, holder_address)`, overwrites on drift (self-heal), and emits
 * `tgr.balance.changed` for corrected rows. `last_reconciled_at` always advances
 * so the cursor rotates through every holder over time.
 *
 * Reorg-safe rollback + reconciliation cost/SLA tuning are Task 11/§11; here we
 * implement only the rotating-cursor batch + drift correction.
 */
@Injectable()
@Processor(RECONCILE_BALANCE_QUEUE)
export class BalanceReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(BalanceReconciliationService.name);
  private contractCache = new Map<string, ContractInstance>();

  constructor(
    @InjectRepository(TokenBalance)
    private readonly tokenBalanceRepository: Repository<TokenBalance>,
    @InjectQueue(RECONCILE_BALANCE_QUEUE)
    private readonly reconcileQueue: Queue,
    private readonly balanceIndexer: BalanceIndexerService,
    private readonly aeSdkService: AeSdkService,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {}

  /**
   * Schedule the single repeatable sweep on boot. Bull dedupes by job id +
   * repeat-opts, so re-registering on every restart is safe. Interval =
   * `TG_RECONCILE_INTERVAL` (default 10m).
   */
  async onModuleInit(): Promise<void> {
    // AEX9 balance reconciliation is an INDEXER (chain-read) concern; it runs in
    // the single always-on process (worker mode removed — see `deworker-plan.md`).
    const everyMs = this.config.reconcileIntervalSec * 1000;
    try {
      await this.reconcileQueue.add(
        RECONCILE_BALANCE_REPEAT_JOB,
        {},
        {
          jobId: RECONCILE_BALANCE_REPEAT_JOB,
          repeat: { every: everyMs },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      this.logger.log(
        `Scheduled reconcile-balance sweep every ${everyMs}ms on '${RECONCILE_BALANCE_QUEUE}'`,
      );
    } catch (error: any) {
      this.logger.error('Failed to schedule reconcile-balance sweep', error);
    }
  }

  @Process(RECONCILE_BALANCE_REPEAT_JOB)
  async handleSweep(): Promise<void> {
    await this.runOnce();
  }

  /**
   * Run a single reconciliation batch. Selects `TG_RECONCILE_BATCH_SIZE` rows by
   * oldest `last_reconciled_at` (nulls first), re-reads each authoritative balance
   * from chain, self-heals drift, and always advances `last_reconciled_at`.
   * Returns the number of rows whose balance was corrected.
   */
  async runOnce(): Promise<number> {
    const batchSize = this.config.reconcileBatchSize;
    const rows = await this.tokenBalanceRepository
      .createQueryBuilder('tb')
      .orderBy('tb.last_reconciled_at', 'ASC', 'NULLS FIRST')
      .take(batchSize)
      .getMany();

    if (rows.length === 0) {
      return 0;
    }

    let tipHeight = 0;
    try {
      tipHeight = await this.aeSdkService.sdk.getHeight();
    } catch (error: any) {
      this.logger.warn(
        'Failed to read current tip height; using stored heights for corrections',
        error,
      );
    }

    let corrected = 0;
    for (const row of rows) {
      try {
        const authoritative = await this.readAuthoritativeBalance(
          row.token_address,
          row.holder_address,
        );
        if (authoritative === null) {
          // Could not read chain: only advance the cursor, don't clobber.
          await this.tokenBalanceRepository.update(
            {
              token_address: row.token_address,
              holder_address: row.holder_address,
            },
            { last_reconciled_at: new Date() },
          );
          continue;
        }

        const changed = await this.balanceIndexer.setAuthoritativeBalance(
          row.token_address,
          row.holder_address,
          authoritative,
          tipHeight || row.updated_height,
        );
        if (changed !== null) {
          corrected++;
          this.balanceIndexer.emitBalanceChanged(
            row.token_address,
            row.holder_address,
          );
        }
      } catch (error: any) {
        this.logger.error(
          `Reconcile failed for ${row.token_address}/${row.holder_address}`,
          error,
        );
        // Still advance the cursor so a single bad row can't wedge the sweep.
        await this.tokenBalanceRepository
          .update(
            {
              token_address: row.token_address,
              holder_address: row.holder_address,
            },
            { last_reconciled_at: new Date() },
          )
          .catch(() => undefined);
      }
    }

    this.logger.debug(
      `Reconcile sweep: scanned ${rows.length}, corrected ${corrected}`,
    );
    return corrected;
  }

  /**
   * Read the authoritative raw balance for one holder from the AEX9 contract's
   * `balance(account)` view (returns `Some(int)` / `None`). `None` (no entry) is
   * treated as 0. Returns `null` only on a read failure so the caller can skip the
   * overwrite and just advance the cursor.
   */
  async readAuthoritativeBalance(
    tokenAddress: string,
    holderAddress: string,
  ): Promise<BigNumber | null> {
    try {
      const contract = await this.getContract(tokenAddress);
      const result = await contract.balance(holderAddress);
      const decoded = result?.decodedResult;
      if (decoded === undefined || decoded === null) {
        return new BigNumber(0);
      }
      return new BigNumber(decoded.toString());
    } catch (error: any) {
      this.logger.warn(
        `readAuthoritativeBalance(${tokenAddress}, ${holderAddress}) failed`,
        error?.message ?? error,
      );
      return null;
    }
  }

  private async getContract(tokenAddress: string): Promise<ContractInstance> {
    const cached = this.contractCache.get(tokenAddress);
    if (cached) {
      return cached;
    }
    const contract = await Contract.initialize({
      ...this.aeSdkService.sdk.getContext(),
      aci: FungibleTokenFullACI,
      address: tokenAddress as Encoded.ContractAddress,
    });
    this.contractCache.set(tokenAddress, contract);
    return contract;
  }
}
