import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, In, Repository } from 'typeorm';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Account } from '../entities/account.entity';
import { Token } from '@/tokens/entities/token.entity';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import {
  LEADERBOARD_SNAPSHOT_MAX_CANDIDATES,
  LeaderboardItem,
  LeaderboardWindow,
} from './leaderboard.types';
import { AccountLeaderboardSnapshot } from '../entities/account-leaderboard-snapshot.entity';
import { BclPnlService, TokenPnlResult } from './bcl-pnl.service';
import { timestampToAeHeight } from '@/utils/getBlochHeight';

const WINDOWS: LeaderboardWindow[] = ['7d', '30d', 'all'];

const PNL_CONCURRENCY = 8;
// ~1 day of key blocks. PnL at a height only reads trades up to it, so points
// this deep are reused across runs; nearer ones could still be reorged. Must
// stay above REORG_DEPTH (the block validation sweep's rewrite window).
export const PNL_CACHE_MIN_DEPTH = 480;
// Reused points are still recomputed this often, so late-indexed history lands.
export const PNL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type PnlTotals = Omit<TokenPnlResult, 'pnls'>;

interface WindowSamples {
  timestamps: number[];
  heights: number[];
}

interface CandidateMeta {
  accountByAddress: Map<string, Account>;
  createdByAddress: Map<string, number>;
  ownedByAddress: Map<string, number>;
}

const pnlKey = (address: string, height: number) => `${address}:${height}`;

function totalsOf(pnl: TokenPnlResult): PnlTotals {
  return {
    totalCostBasisAe: pnl.totalCostBasisAe,
    totalCostBasisUsd: pnl.totalCostBasisUsd,
    totalCurrentValueAe: pnl.totalCurrentValueAe,
    totalCurrentValueUsd: pnl.totalCurrentValueUsd,
    totalGainAe: pnl.totalGainAe,
    totalGainUsd: pnl.totalGainUsd,
  };
}

@Injectable()
export class LeaderboardSnapshotService {
  private readonly logger = new Logger(LeaderboardSnapshotService.name);
  private isRunning = false;
  private readonly pnlCache = new Map<
    string,
    { totals: PnlTotals; computedAt: number }
  >();

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    @InjectRepository(TokenHolder)
    private readonly tokenHolderRepository: Repository<TokenHolder>,
    @InjectRepository(AccountLeaderboardSnapshot)
    private readonly snapshotRepository: Repository<AccountLeaderboardSnapshot>,
    private readonly bclPnlService: BclPnlService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async refreshAllWindows(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    try {
      const startTime = Date.now();
      const referenceEnd = new Date();
      const candidates = await this.loadCandidates();
      if (!candidates.length) {
        for (const window of WINDOWS) {
          await this.writeWindow(window, []);
        }
        return;
      }

      const samples = new Map<LeaderboardWindow, WindowSamples>();
      for (const window of WINDOWS) {
        samples.set(window, await this.sampleWindow(window, referenceEnd));
      }
      const { totals, computed, failed } = await this.resolvePnlTotals(
        candidates,
        [...samples.values()].flatMap((s) => s.heights),
      );
      const ranked = candidates.filter((address) => !failed.has(address));
      if (!ranked.length) {
        // Smells like a database problem; keep the previous snapshot.
        throw new Error('PnL failed for every candidate');
      }
      const meta = await this.loadCandidateMeta(ranked);

      for (const window of WINDOWS) {
        const items = await this.buildWindow(
          window,
          referenceEnd,
          ranked,
          samples.get(window)!,
          totals,
          meta,
        );
        await this.writeWindow(window, items);
      }
      this.logger.log(
        `Refreshed leaderboard snapshots in ${Date.now() - startTime}ms ` +
          `(${computed} of ${totals.size} PnL points computed, ` +
          `${failed.size} candidates failed)`,
      );
    } catch (e) {
      this.logger.error(
        `Failed to refresh leaderboard snapshots: ${(e as Error).message}`,
        (e as Error).stack,
      );
    } finally {
      this.isRunning = false;
    }
  }

  private getWindowRange(
    window: LeaderboardWindow,
    referenceEnd: Date,
  ): {
    start?: Date;
    end: Date;
  } {
    const end = new Date(referenceEnd);
    if (window === 'all') {
      // Treat "all" as last 365 days for window-based metrics
      const start = new Date(end.getTime() - 365 * 24 * 3600 * 1000);
      return { start, end };
    }
    const start =
      window === '7d'
        ? new Date(end.getTime() - 7 * 24 * 3600 * 1000)
        : new Date(end.getTime() - 30 * 24 * 3600 * 1000);
    return { start, end };
  }

  /** Top candidate addresses by all-time USD volume. */
  private async loadCandidates(): Promise<string[]> {
    const rows = await this.transactionsRepository
      .createQueryBuilder('t')
      .select('t.address', 'address')
      .addSelect(
        "COALESCE(SUM(CAST(CASE WHEN lower(t.amount->>'usd') = 'nan' THEN NULL ELSE t.amount->>'usd' END AS DECIMAL)), 0)",
        'volume_usd',
      )
      .groupBy('t.address')
      .orderBy('volume_usd', 'DESC')
      .limit(LEADERBOARD_SNAPSHOT_MAX_CANDIDATES)
      .getRawMany<{ address: string; volume_usd: string }>();
    return rows.map((r) => r.address);
  }

  private async loadCandidateMeta(
    candidates: string[],
  ): Promise<CandidateMeta> {
    const accounts = await this.accountRepository.find({
      where: { address: In(candidates) },
    });

    const createdRaw = await this.tokenRepository
      .createQueryBuilder('tok')
      .select('tok.creator_address', 'creator_address')
      .addSelect('COUNT(*)', 'created_count')
      .where('tok.creator_address IN (:...addresses)', {
        addresses: candidates,
      })
      .groupBy('tok.creator_address')
      .getRawMany<{ creator_address: string; created_count: string }>();

    const ownedRaw = await this.tokenHolderRepository
      .createQueryBuilder('th')
      .select('th.address', 'address')
      .addSelect('COUNT(DISTINCT th.aex9_address)', 'owned_count')
      .where('th.address IN (:...addresses)', { addresses: candidates })
      .andWhere('CAST(th.balance AS DECIMAL) > 0')
      .groupBy('th.address')
      .getRawMany<{ address: string; owned_count: string }>();

    return {
      accountByAddress: new Map(accounts.map((a) => [a.address, a])),
      createdByAddress: new Map(
        createdRaw.map((r) => [r.creator_address, Number(r.created_count)]),
      ),
      ownedByAddress: new Map(
        ownedRaw.map((r) => [r.address, Number(r.owned_count)]),
      ),
    };
  }

  private async sampleWindow(
    window: LeaderboardWindow,
    referenceEnd: Date,
  ): Promise<WindowSamples> {
    const { start, end } = this.getWindowRange(window, referenceEnd);
    const endMs = end.getTime();
    const startMs = start ? start.getTime() : endMs;
    const durationMs = Math.max(endMs - startMs, 1);
    const pointCount = window === '7d' ? 8 : window === '30d' ? 12 : 24;

    const timestamps: number[] = [];
    for (let i = 0; i < pointCount; i++) {
      timestamps.push(
        Math.floor(startMs + durationMs * (i / (pointCount - 1))),
      );
    }

    const heights: number[] = [];
    let previousHeight: number | undefined = undefined;
    for (const ts of timestamps) {
      const h = await timestampToAeHeight(ts, previousHeight, this.dataSource);
      heights.push(h);
      previousHeight = h;
    }
    return { timestamps, heights };
  }

  // timestampToAeHeight snaps points older than 48h to the end of their day, so
  // most heights repeat from run to run and come from the cache.
  private async resolvePnlTotals(
    addresses: string[],
    heights: number[],
  ): Promise<{
    totals: Map<string, PnlTotals>;
    computed: number;
    failed: Set<string>;
  }> {
    const uniqueHeights = [...new Set(heights)];
    const cacheableBelow = Math.max(...uniqueHeights) - PNL_CACHE_MIN_DEPTH;
    const now = Date.now();
    const totals = new Map<string, PnlTotals>();

    // Height-major, so concurrent workers query different accounts and a
    // failing account is tried once instead of once per worker.
    const queue: Array<[string, number]> = [];
    for (const height of uniqueHeights) {
      for (const address of addresses) {
        const cached = this.pnlCache.get(pnlKey(address, height));
        if (cached && now - cached.computedAt < PNL_CACHE_TTL_MS) {
          totals.set(pnlKey(address, height), cached.totals);
        } else {
          queue.push([address, height]);
        }
      }
    }

    // One failing account skips its remaining points instead of failing the
    // run, so the rest of the leaderboard still refreshes.
    const failed = new Set<string>();
    let computed = 0;
    await Promise.all(
      Array.from({ length: PNL_CONCURRENCY }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const [address, height] = next;
          if (failed.has(address)) {
            continue;
          }
          try {
            const pnlTotals = totalsOf(
              await this.bclPnlService.calculateTokenPnls(address, height),
            );
            totals.set(pnlKey(address, height), pnlTotals);
            computed++;
            if (height <= cacheableBelow) {
              this.pnlCache.set(pnlKey(address, height), {
                totals: pnlTotals,
                computedAt: now,
              });
            }
          } catch (e) {
            failed.add(address);
            this.logger.warn(
              `Failed to compute PnL for ${address} at height ${height}: ` +
                (e as Error).message,
            );
          }
        }
      }),
    );

    // Keep only what this run sampled, so the cache stays about one run's size.
    for (const key of this.pnlCache.keys()) {
      if (!totals.has(key)) {
        this.pnlCache.delete(key);
      }
    }
    return { totals, computed, failed };
  }

  private async buildWindow(
    window: LeaderboardWindow,
    referenceEnd: Date,
    candidates: string[],
    samples: WindowSamples,
    totals: Map<string, PnlTotals>,
    meta: CandidateMeta,
  ): Promise<LeaderboardItem[]> {
    const { start, end } = this.getWindowRange(window, referenceEnd);

    const countsRaw = await this.transactionsRepository
      .createQueryBuilder('t')
      .select('t.address', 'address')
      .addSelect(
        `SUM(CASE WHEN t.tx_type = 'buy' THEN 1 ELSE 0 END)`,
        'buy_count',
      )
      .addSelect(
        `SUM(CASE WHEN t.tx_type = 'sell' THEN 1 ELSE 0 END)`,
        'sell_count',
      )
      .where('t.address IN (:...addresses)', { addresses: candidates })
      .andWhere(start ? 't.created_at >= :start' : '1=1', { start })
      .andWhere('t.created_at <= :end', { end })
      .groupBy('t.address')
      .getRawMany<{ address: string; buy_count: string; sell_count: string }>();
    const countsByAddress = new Map(countsRaw.map((r) => [r.address, r]));

    return candidates.map((address) => {
      const pointTotals = samples.heights.map((height) =>
        totals.get(pnlKey(address, height))!,
      );
      const spark: Array<[number, number]> = pointTotals.map((pnl, i) => [
        samples.timestamps[i],
        Math.max(pnl.totalCurrentValueUsd, 0),
      ]);
      const lastPnl = pointTotals[pointTotals.length - 1];

      const aumStartSpark = spark[0][1];
      const aumEndUsd = spark[spark.length - 1][1];

      let pnlWindowUsd = aumEndUsd - aumStartSpark;
      let roiWindowPct =
        aumStartSpark > 0 ? (pnlWindowUsd / aumStartSpark) * 100 : 0;

      // For "all" window, use true all-time ROI from PNL data
      if (window === 'all') {
        pnlWindowUsd = lastPnl.totalGainUsd;
        if (lastPnl.totalCostBasisUsd > 0) {
          roiWindowPct =
            (lastPnl.totalGainUsd / lastPnl.totalCostBasisUsd) * 100;
        } else if (lastPnl.totalCostBasisAe > 0) {
          roiWindowPct = (lastPnl.totalGainAe / lastPnl.totalCostBasisAe) * 100;
        } else {
          roiWindowPct = 0;
        }
      }

      // MDD over sampled series
      let peak = Number.NEGATIVE_INFINITY;
      let maxDrawdown = 0;
      for (const [, v] of spark) {
        if (v > peak) peak = v;
        if (peak > 0) {
          const dd = (peak - v) / peak;
          if (dd > maxDrawdown) maxDrawdown = dd;
        }
      }

      const counts = countsByAddress.get(address);
      return {
        address,
        chain_name: meta.accountByAddress.get(address)?.chain_name ?? null,
        aum_usd: aumEndUsd,
        pnl_usd: pnlWindowUsd,
        roi_pct: roiWindowPct,
        mdd_pct: maxDrawdown * 100,
        buy_count: counts ? Number(counts.buy_count) : 0,
        sell_count: counts ? Number(counts.sell_count) : 0,
        created_tokens_count: meta.createdByAddress.get(address) ?? 0,
        owned_trends_count: meta.ownedByAddress.get(address) ?? 0,
        portfolio_value_usd_sparkline: spark,
      };
    });
  }

  private async writeWindow(
    window: LeaderboardWindow,
    items: LeaderboardItem[],
  ): Promise<void> {
    await this.snapshotRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AccountLeaderboardSnapshot);
      await repo.delete({ window });

      const snapshots = items.map((item) =>
        repo.create({
          window,
          address: item.address,
          chain_name: item.chain_name ?? null,
          aum_usd: item.aum_usd,
          pnl_usd: item.pnl_usd,
          roi_pct: item.roi_pct,
          mdd_pct: item.mdd_pct,
          buy_count: item.buy_count,
          sell_count: item.sell_count,
          created_tokens_count: item.created_tokens_count,
          owned_trends_count: item.owned_trends_count,
          portfolio_value_usd_sparkline: item.portfolio_value_usd_sparkline,
        }),
      );
      if (snapshots.length) {
        await repo.save(snapshots);
      }
    });
  }
}
