import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Token } from '@/tokens/entities/token.entity';
import { TokensService } from '@/tokens/tokens.service';
import { MAX_TOKENS_TO_CHECK_WITHOUT_HOLDERS } from '@/configs/constants';
import { ACTIVE_NETWORK } from '@/configs/network';
import { fetchJson } from '@/utils/common';
import { BalanceIndexerService } from './balance-indexer.service';
import { EligibilityService } from './eligibility.service';

/** Latest on-chain BCL call the middleware knows for a sale contract. */
interface LatestSaleTx {
  hash: string;
  height: number;
}

/**
 * Self-heal for community-room tokens whose indexed state has fallen behind the
 * chain.
 *
 * A token's holder rows and `last_sync_block_height` are advanced ONLY on the
 * live-websocket path (see `TransactionProcessorService`); the backfill indexer
 * never touches them. A single missed or failed live tx therefore freezes a
 * token's holders and height until its next successful live tx — which, for a
 * quiet token, may never arrive. The existing holder self-heal only revisits
 * tokens with `holders_count = 0`, so a token merely missing a *new* holder is
 * never reconciled.
 *
 * This rotating, batch-bounded sweep closes that gap for the room surface. Each
 * run it takes the next {@link MAX_TOKENS_TO_CHECK_WITHOUT_HOLDERS} community-room
 * tokens (rotating cursor over `sale_address`) and, for any whose latest
 * middleware tx disagrees with the stored `last_tx_hash`/height, re-syncs holders
 * and the `token_balance` ledger from middleware truth, drives the existing room
 * eligibility recompute, and advances the sync height monotonically so a healed
 * token stops matching the discrepancy predicate.
 */
@Injectable()
export class StaleTokenSyncService {
  private readonly logger = new Logger(StaleTokenSyncService.name);

  /** Re-entrancy guard: a slow run must not overlap the next tick. */
  private running = false;

  /** Rotating cursor: last `sale_address` scanned; '' restarts from the top. */
  private cursor = '';

  constructor(
    @InjectRepository(Token)
    private readonly tokenRepo: Repository<Token>,
    private readonly tokensService: TokensService,
    private readonly balanceIndexer: BalanceIndexerService,
    private readonly eligibility: EligibilityService,
  ) {}

  /** Reset the rotating cursor (tests). */
  resetCursor(): void {
    this.cursor = '';
  }

  /** Current rotating cursor value (tests/observability). */
  getCursor(): string {
    return this.cursor;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const { scanned, healed } = await this.runOnce();
      if (scanned > 0) {
        this.logger.log(
          `stale-token sweep: scanned ${scanned}, healed ${healed}`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `stale-token sweep failed: ${error?.message ?? error}`,
        error?.stack,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Run one rotating batch. Selects the next {@link MAX_TOKENS_TO_CHECK_WITHOUT_HOLDERS}
   * community-room tokens after the cursor, reconciles each, advances the cursor
   * per token (so one bad token cannot wedge the rotation), and wraps at the end.
   */
  async runOnce(): Promise<{ scanned: number; healed: number }> {
    const limit = MAX_TOKENS_TO_CHECK_WITHOUT_HOLDERS;
    const tokens = await this.tokenRepo
      .createQueryBuilder('t')
      .where('t.has_nostr_room = :hasRoom', { hasRoom: true })
      .andWhere('t.sale_address > :cursor', { cursor: this.cursor })
      .orderBy('t.sale_address', 'ASC')
      .take(limit)
      .getMany();

    if (tokens.length === 0) {
      this.cursor = '';
      return { scanned: 0, healed: 0 };
    }

    let healed = 0;
    for (const token of tokens) {
      try {
        if (await this.reconcileToken(token)) {
          healed++;
        }
      } catch (error: any) {
        this.logger.error(
          `reconcileToken(${token.sale_address}) failed: ${error?.message ?? error}`,
        );
      }
      this.cursor = token.sale_address;
    }

    if (tokens.length < limit) {
      this.cursor = '';
    }

    return { scanned: tokens.length, healed };
  }

  /**
   * Heal one token iff the middleware's latest sale-contract tx disagrees with the
   * stored sync cursor. Returns `true` when a heal was performed.
   *
   * The discrepancy predicate is a per-token comparison against middleware truth,
   * never "`last_sync_block_height < chain tip`" — the latter is true of every
   * quiet token forever (its height only moves on its own live txs) and would
   * re-sync the whole table every run.
   */
  async reconcileToken(token: Token): Promise<boolean> {
    const latest = await this.getLatestSaleTx(token.sale_address);
    if (!latest) {
      return false;
    }

    const storedHeight = token.last_sync_block_height ?? -1;
    const inSync =
      latest.hash === token.last_tx_hash || latest.height < storedHeight;
    if (inSync) {
      return false;
    }

    // Re-sync holders (heals `/accounts/{addr}/tokens` + `/tokens/{sale}/holders`)
    // and get back the authoritative set so the balance ledger is seeded from the
    // same read.
    const result = await this.tokensService.loadAndSaveTokenHoldersFromMdw(
      token.sale_address as Parameters<
        TokensService['loadAndSaveTokenHoldersFromMdw']
      >[0],
    );
    if (!result) {
      // Could not sync (missing token/aex9, partial data, or a concurrent sync
      // holds the lock). Leave the token flagged stale and DO NOT advance the
      // height, so the next run retries.
      return false;
    }

    // Seed the `token_balance` ledger `/rooms` eligibility reads, then drive the
    // existing room recompute — no parallel eligibility engine.
    for (const holder of result.holders) {
      await this.balanceIndexer.setAuthoritativeBalance(
        result.aex9Address,
        holder.address,
        holder.balance,
        latest.height,
      );
    }
    await this.eligibility.recomputeRoomFromHolders(token.sale_address);

    // Advance the sync cursor monotonically. `inSync` already excluded a lower
    // height; guard again so a heal can never regress the stored height.
    if (latest.height >= (token.last_sync_block_height ?? 0)) {
      await this.tokenRepo.update(
        { sale_address: token.sale_address },
        { last_sync_block_height: latest.height, last_tx_hash: latest.hash },
      );
    }

    return true;
  }

  /** Latest `contract_call` on the sale contract per the middleware; `null` on any failure. */
  private async getLatestSaleTx(
    saleAddress: string,
  ): Promise<LatestSaleTx | null> {
    try {
      const query = new URLSearchParams({
        direction: 'backward',
        limit: '1',
        type: 'contract_call',
        contract: saleAddress,
      }).toString();
      const response = await fetchJson(
        `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${query}`,
      );
      const tx = response?.data?.[0];
      if (!tx?.hash || typeof tx.block_height !== 'number') {
        return null;
      }
      return { hash: tx.hash, height: tx.block_height };
    } catch (error: any) {
      this.logger.warn(
        `getLatestSaleTx(${saleAddress}) failed: ${error?.message ?? error}`,
      );
      return null;
    }
  }
}
