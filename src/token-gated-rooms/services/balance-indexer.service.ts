import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConfigType } from '@nestjs/config';
import { IsNull, Not, Repository } from 'typeorm';
import { BigNumber } from 'bignumber.js';
import { Token } from '@/tokens/entities/token.entity';
import { LIVE_TX_EVENT, LiveTxEventPayload } from '@/mdw-sync/events';
import { BCL_FUNCTIONS } from '@/configs/constants';
import { TokenBalance } from '../entities/token-balance.entity';
import tgrConfig from '../config/tgr.config';
import {
  TGR_BALANCE_CHANGED,
  TGR_COMMUNITY_UPSERTED,
  TgrBalanceChangedPayload,
  TgrCommunityUpsertedPayload,
} from '../events';

/**
 * Owns the **community-token allowlist** (the set of AEX9 contract `address`es the
 * AEX9-transfer plugin indexes) plus the `token_balance` upsert helpers (plan
 * §5.3/§5.4).
 *
 * Allowlist = `Token.address` (the AEX9 contract id, NOT `sale_address`). Held in
 * an in-memory `Set<string>` with a TTL so a refresh re-reads the DB at most once
 * per `communityTokenRefreshSec`. Refresh triggers:
 *  - lazy TTL expiry (any `isCommunityToken` call past the TTL re-loads);
 *  - the in-process `tgr.community.upserted` event (a token got/changed its room);
 *  - reactively from `LIVE_TX_EVENT` when a `create_community` tx is seen, so a
 *    brand-new token's transfers index on its very next call (plan §5.3).
 *
 * Balances are stored as **raw integer base units** — never divided by
 * `10**decimals`. Upserts clamp at 0 (no negative balances, mirroring
 * `TokenHolderService.calculateNewBalance`) and emit `tgr.balance.changed` only
 * when the persisted `balance` actually changes.
 */
@Injectable()
export class BalanceIndexerService {
  private readonly logger = new Logger(BalanceIndexerService.name);

  /** AEX9 contract addresses of community tokens (the indexing allowlist). */
  private allowlist = new Set<string>();
  /** Epoch ms when `allowlist` was last loaded from the DB; 0 = never. */
  private allowlistLoadedAt = 0;
  /** Guards against concurrent reloads (the refresh is async). */
  private reloading: Promise<void> | null = null;

  constructor(
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    @InjectRepository(TokenBalance)
    private readonly tokenBalanceRepository: Repository<TokenBalance>,
    private readonly eventEmitter: EventEmitter2,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {}

  private get ttlMs(): number {
    return this.config.communityTokenRefreshSec * 1000;
  }

  /**
   * Synchronous allowlist membership check used by the plugin predicate (the MDW
   * filter is sync). If the TTL has expired this kicks off a non-blocking reload
   * for the *next* call but answers from the current snapshot — predicates must
   * not await. A brand-new token is still caught immediately by the
   * `create_community` LIVE_TX hook below.
   */
  isCommunityToken(address: string | undefined | null): boolean {
    if (!address) {
      return false;
    }
    if (this.isStale()) {
      void this.refreshAllowlist();
    }
    return this.allowlist.has(address);
  }

  private isStale(): boolean {
    return Date.now() - this.allowlistLoadedAt >= this.ttlMs;
  }

  /** Current allowlist snapshot (read-only copy, for tests/observability). */
  getAllowlist(): Set<string> {
    return new Set(this.allowlist);
  }

  /**
   * Reload the allowlist from `Token` where `address` is set. Deduped: concurrent
   * callers await the same in-flight load. Always refreshes the TTL timestamp so a
   * transient empty DB doesn't cause a hot reload loop.
   */
  async refreshAllowlist(): Promise<void> {
    if (this.reloading) {
      return this.reloading;
    }
    this.reloading = (async () => {
      try {
        const rows = await this.tokenRepository.find({
          where: { address: Not(IsNull()) },
          select: { address: true },
        });
        const next = new Set<string>();
        for (const row of rows) {
          if (row.address) {
            next.add(row.address);
          }
        }
        this.allowlist = next;
        this.allowlistLoadedAt = Date.now();
        this.logger.debug(
          `Allowlist refreshed: ${next.size} community token(s)`,
        );
      } catch (error: any) {
        this.logger.error('Failed to refresh community-token allowlist', error);
        // Keep the TTL moving so we don't hot-loop on a DB hiccup.
        this.allowlistLoadedAt = Date.now();
      } finally {
        this.reloading = null;
      }
    })();
    return this.reloading;
  }

  /** Add a single AEX9 address to the live allowlist without a full reload. */
  addToAllowlist(address: string | undefined | null): void {
    if (address) {
      this.allowlist.add(address);
    }
  }

  /**
   * A token got/changed its room (Task 04 emits this). Make sure its AEX9
   * `address` is indexable immediately. Non-blocking (the emitter does not await).
   */
  @OnEvent(TGR_COMMUNITY_UPSERTED, { async: true })
  async onCommunityUpserted(
    payload: TgrCommunityUpsertedPayload,
  ): Promise<void> {
    try {
      const token = await this.tokenRepository.findOne({
        where: { sale_address: payload.saleAddress },
        select: { address: true },
      });
      this.addToAllowlist(token?.address);
    } catch (error: any) {
      this.logger.warn(
        `onCommunityUpserted(${payload.saleAddress}) failed`,
        error,
      );
    }
  }

  /**
   * Reactive dynamic subscription (plan §5.3): when a `create_community` tx lands
   * on the live stream, refresh the allowlist so the new token's AEX9 transfers
   * are indexed from its very first call. Non-blocking — `LIVE_TX_EVENT` is
   * emitted without await.
   */
  @OnEvent(LIVE_TX_EVENT, { async: true })
  async onLiveTx(tx: LiveTxEventPayload): Promise<void> {
    if (
      tx?.type === 'ContractCallTx' &&
      tx.function === BCL_FUNCTIONS.create_community
    ) {
      await this.refreshAllowlist();
    }
  }

  /**
   * Apply a signed delta to a holder's raw balance for a token, clamping at 0
   * (never persist negative). Returns the new balance iff it actually changed
   * (so the caller can emit `tgr.balance.changed`), else `null`. Does NOT emit —
   * the sync service emits after the whole tx's legs are applied/idempotency-safe.
   */
  async applyDelta(
    tokenAddress: string,
    holderAddress: string,
    delta: BigNumber,
    updatedHeight: number,
  ): Promise<BigNumber | null> {
    const existing = await this.tokenBalanceRepository.findOne({
      where: { token_address: tokenAddress, holder_address: holderAddress },
    });

    const current = existing?.balance ?? new BigNumber(0);
    const normalized = current.isNegative() ? new BigNumber(0) : current;
    let next = normalized.plus(delta);
    if (next.isNegative()) {
      next = new BigNumber(0);
    }

    if (existing && existing.balance.eq(next)) {
      // No-op (e.g. a clamp that lands on the same value): keep height fresh but
      // do not signal a change.
      if (updatedHeight > existing.updated_height) {
        await this.tokenBalanceRepository.update(
          { token_address: tokenAddress, holder_address: holderAddress },
          { updated_height: updatedHeight },
        );
      }
      return null;
    }

    await this.tokenBalanceRepository.save(
      this.tokenBalanceRepository.create({
        token_address: tokenAddress,
        holder_address: holderAddress,
        balance: next,
        updated_height: updatedHeight,
      }),
    );
    return next;
  }

  /**
   * Overwrite a holder's raw balance to an authoritative value (reconciliation
   * self-heal). Returns the value iff it changed, else `null`. Sets
   * `updated_height` to `tipHeight` and `last_reconciled_at = now`.
   */
  async setAuthoritativeBalance(
    tokenAddress: string,
    holderAddress: string,
    authoritative: BigNumber,
    tipHeight: number,
  ): Promise<BigNumber | null> {
    const existing = await this.tokenBalanceRepository.findOne({
      where: { token_address: tokenAddress, holder_address: holderAddress },
    });
    const now = new Date();
    const changed = !existing || !existing.balance.eq(authoritative);

    await this.tokenBalanceRepository.save(
      this.tokenBalanceRepository.create({
        token_address: tokenAddress,
        holder_address: holderAddress,
        balance: authoritative,
        updated_height: changed
          ? tipHeight
          : (existing?.updated_height ?? tipHeight),
        last_reconciled_at: now,
      }),
    );

    return changed ? authoritative : null;
  }

  /** Emit the canonical `tgr.balance.changed` (thin payload, plan §5/Shared). */
  emitBalanceChanged(tokenAddress: string, holderAddress: string): void {
    const payload: TgrBalanceChangedPayload = {
      tokenAddress,
      holderAddress,
    };
    this.eventEmitter.emit(TGR_BALANCE_CHANGED, payload);
  }
}
