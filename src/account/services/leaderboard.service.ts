import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import moment from 'moment';
import { In, Repository } from 'typeorm';
import { Account } from '../entities/account.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Token } from '@/tokens/entities/token.entity';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import {
  PortfolioService,
  PortfolioHistorySnapshot,
} from './portfolio.service';

export type LeaderboardWindow = '7d' | '30d' | 'all';
export type LeaderboardSortBy = 'pnl' | 'roi' | 'mdd' | 'aum';
export type LeaderboardSortDir = 'ASC' | 'DESC';

export interface GetLeadersParams {
  window: LeaderboardWindow;
  sortBy: LeaderboardSortBy;
  sortDir?: LeaderboardSortDir;
  page?: number;
  limit?: number;
  points?: number;
  minAumUsd?: number;
  maxCandidates?: number;
}

export interface LeaderboardItem {
  address: string;
  chain_name?: string | null;
  // metrics
  aum_usd: number;
  pnl_usd: number;
  roi_pct: number;
  mdd_pct: number;
  // activity
  buy_count: number;
  sell_count: number;
  created_tokens_count: number;
  owned_trends_count: number;
  // chart
  portfolio_value_usd_sparkline: Array<[number, number]>;
}

function computeMaxDrawdownPct(series: Array<[number, number]>): number {
  // series: [timestamp_ms, value_usd]
  let peak = Number.NEGATIVE_INFINITY;
  let maxDrawdown = 0; // as positive fraction, later *100
  for (const [, value] of series) {
    if (value > peak) {
      peak = value;
    }
    if (peak > 0) {
      const drawdown = (peak - value) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }
  return maxDrawdown * 100;
}

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    @InjectRepository(TokenHolder)
    private readonly tokenHolderRepository: Repository<TokenHolder>,
    private readonly portfolioService: PortfolioService,
  ) {}

  private getWindowRange(window: LeaderboardWindow): {
    start?: Date;
    end: Date;
  } {
    const end = new Date();
    if (window === 'all') {
      return { end };
    }
    const start =
      window === '7d'
        ? moment(end).subtract(7, 'days').toDate()
        : moment(end).subtract(30, 'days').toDate();
    return { start, end };
  }

  private getRecommendedIntervalSeconds(
    window: LeaderboardWindow,
    points?: number,
  ): number {
    // Aim to return ~points points; hard-cap to 12 for responsiveness
    const requested = points && points > 4 ? points : 8;
    const targetPoints = Math.min(requested, 12);
    if (window === '7d') {
      // 7 days -> 7 * 24 * 3600 seconds total
      return Math.ceil((7 * 24 * 3600) / targetPoints);
    }
    if (window === '30d') {
      return Math.ceil((30 * 24 * 3600) / targetPoints);
    }
    // 'all' → approximate last 90d window for sparkline compactness
    return Math.ceil((90 * 24 * 3600) / targetPoints);
  }

  async getLeaders(
    params: GetLeadersParams,
  ): Promise<{ items: LeaderboardItem[]; totalCandidates: number }> {
    const window = params.window ?? '7d';
    const sortBy = params.sortBy ?? 'pnl';
    const sortDir = params.sortDir ?? (sortBy === 'mdd' ? 'ASC' : 'DESC');
    const page = Math.max(1, params.page || 1);
    const limit = Math.max(1, Math.min(params.limit || 18, 50));
    const minAumUsd = params.minAumUsd ?? 1; // default: exclude ~0 AUM
    const { start, end } = this.getWindowRange(window);

    // Prefilter candidate addresses using Accounts table (stable across windows)
    const effectiveCandidateLimit = Math.max(
      limit * 2,
      Math.min(params.maxCandidates ?? 36, 100),
    );
    // Use transactions across all time to get stable top traders (not window-bound)
    const txTop = await this.transactionsRepository
      .createQueryBuilder('t')
      .select('t.address', 'address')
      .addSelect(
        "COALESCE(SUM(CAST(CASE WHEN lower(t.amount->>'usd') = 'nan' THEN NULL ELSE t.amount->>'usd' END AS DECIMAL)), 0)",
        'volume_usd',
      )
      .groupBy('t.address')
      .orderBy('volume_usd', 'DESC')
      .limit(effectiveCandidateLimit)
      .getRawMany<{ address: string; volume_usd: string }>();
    const candidateAddresses = txTop.map((r) => r.address);

    if (candidateAddresses.length === 0) {
      return { items: [], totalCandidates: 0 };
    }

    // Load basic account meta (chain_name, etc.)
    const accounts = await this.accountRepository.find({
      where: { address: In(candidateAddresses) },
    });
    const accountByAddress = new Map(accounts.map((a) => [a.address, a]));

    // Aggregate buy/sell counts in one query for the window and candidate set
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
      .where('t.address IN (:...addresses)', { addresses: candidateAddresses })
      .andWhere(start ? 't.created_at >= :start' : '1=1', { start })
      .andWhere('t.created_at <= :end', { end })
      .groupBy('t.address')
      .getRawMany<{ address: string; buy_count: string; sell_count: string }>();
    const countsByAddress = new Map(countsRaw.map((r) => [r.address, r]));

    // Created tokens (lifetime count)
    const createdRaw = await this.tokenRepository
      .createQueryBuilder('tok')
      .select('tok.creator_address', 'creator_address')
      .addSelect('COUNT(*)', 'created_count')
      .where('tok.creator_address IN (:...addresses)', {
        addresses: candidateAddresses,
      })
      .groupBy('tok.creator_address')
      .getRawMany<{ creator_address: string; created_count: string }>();
    const createdByAddress = new Map(
      createdRaw.map((r) => [r.creator_address, r]),
    );

    // Owned trends count (distinct holdings with balance > 0)
    const ownedRaw = await this.tokenHolderRepository
      .createQueryBuilder('th')
      .select('th.address', 'address')
      .addSelect('COUNT(DISTINCT th.aex9_address)', 'owned_count')
      .where('th.address IN (:...addresses)', { addresses: candidateAddresses })
      .andWhere('CAST(th.balance AS DECIMAL) > 0')
      .groupBy('th.address')
      .getRawMany<{ address: string; owned_count: string }>();
    const ownedByAddress = new Map(ownedRaw.map((r) => [r.address, r]));

    // Compute portfolio history for each candidate (bounded by candidate limit)
    const startMoment = start ? moment(start) : undefined;
    // For 'all', we will use ~90d range to compute sparkline/metrics
    const effectiveStartMoment =
      window === 'all' ? moment(end).subtract(90, 'days') : startMoment;
    const endMoment = moment(end);

    // Limit concurrency and apply a time budget to avoid timeouts
    const concurrency = 8;
    const timeBudgetMs = 8_000;
    const deadline = Date.now() + timeBudgetMs;
    const seriesByAddress = new Map<string, Array<[number, number]>>();
    const metricsIntermediate: Array<{
      address: string;
      aum_usd: number;
      pnl_usd: number;
      roi_pct: number;
      mdd_pct: number;
    }> = [];

    const tasks = candidateAddresses.map((address) => async () => {
      try {
        if (Date.now() > deadline) {
          return;
        }
        const history: PortfolioHistorySnapshot[] =
          await this.portfolioService.getPortfolioHistory(address, {
            startDate: effectiveStartMoment,
            endDate: endMoment,
            interval: this.getRecommendedIntervalSeconds(window, params.points),
            convertTo: 'usd',
            includePnl: false,
          });
        if (!history || history.length === 0) {
          return;
        }
        const spark: Array<[number, number]> = history.map((h) => {
          const ts =
            typeof h.timestamp === 'string' || h.timestamp instanceof Date
              ? new Date(h.timestamp as any).getTime()
              : (h.timestamp as any).valueOf();
          return [ts, Number(h.total_value_usd || 0)];
        });
        // Ensure chronological
        spark.sort((a, b) => a[0] - b[0]);

        const firstVal = spark[0]?.[1] ?? 0;
        const lastVal = spark[spark.length - 1]?.[1] ?? 0;
        const pnl = lastVal - firstVal;
        const roi = firstVal > 0 ? (pnl / firstVal) * 100 : 0;
        const mdd = computeMaxDrawdownPct(spark);

        seriesByAddress.set(address, spark);
        metricsIntermediate.push({
          address,
          aum_usd: lastVal,
          pnl_usd: pnl,
          roi_pct: roi,
          mdd_pct: mdd,
        });
      } catch (e) {
        this.logger.warn(
          `Failed to build portfolio history for ${address}: ${(e as Error).message}`,
        );
      }
    });

    // Run with concurrency control
    const queue = [...tasks];
    const runners: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      const runner = (async () => {
        while (queue.length && Date.now() < deadline) {
          const job = queue.shift();
          if (job) {
            await job();
          }
        }
      })();
      runners.push(runner);
    }
    await Promise.all(runners);

    // Build items merging all aggregates
    let items: LeaderboardItem[] = metricsIntermediate.map((m) => {
      const acct = accountByAddress.get(m.address);
      const counts = countsByAddress.get(m.address);
      const created = createdByAddress.get(m.address);
      const owned = ownedByAddress.get(m.address);
      return {
        address: m.address,
        chain_name: acct?.chain_name ?? null,
        aum_usd: m.aum_usd,
        pnl_usd: m.pnl_usd,
        roi_pct: m.roi_pct,
        mdd_pct: m.mdd_pct,
        buy_count: counts ? Number(counts.buy_count) : 0,
        sell_count: counts ? Number(counts.sell_count) : 0,
        created_tokens_count: created ? Number(created.created_count) : 0,
        owned_trends_count: owned ? Number(owned.owned_count) : 0,
        portfolio_value_usd_sparkline: seriesByAddress.get(m.address) || [],
      };
    });

    // Filter out leaders with AUM below threshold (encourage active traders)
    if (minAumUsd > 0) {
      items = items.filter((it) => (it.aum_usd ?? 0) >= minAumUsd);
    }

    // Sort by requested metric
    const dir = sortDir === 'ASC' ? 1 : -1;
    items.sort((a, b) => {
      const av =
        sortBy === 'pnl'
          ? a.pnl_usd
          : sortBy === 'roi'
            ? a.roi_pct
            : sortBy === 'mdd'
              ? a.mdd_pct
              : a.aum_usd;
      const bv =
        sortBy === 'pnl'
          ? b.pnl_usd
          : sortBy === 'roi'
            ? b.roi_pct
            : sortBy === 'mdd'
              ? b.mdd_pct
              : b.aum_usd;
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });

    // Paginate
    const startIdx = (page - 1) * limit;
    const pageItems = items.slice(startIdx, startIdx + limit);

    return {
      items: pageItems,
      totalCandidates: items.length,
    };
  }
}
