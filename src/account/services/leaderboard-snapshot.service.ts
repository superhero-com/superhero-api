import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, In, Repository } from 'typeorm';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Account } from '../entities/account.entity';
import { Token } from '@/tokens/entities/token.entity';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { LeaderboardItem, LeaderboardWindow } from './leaderboard.service';
import { AccountLeaderboardSnapshot } from '../entities/account-leaderboard-snapshot.entity';
import { BclPnlService, TokenPnlResult } from './bcl-pnl.service';
import { timestampToAeHeight } from '@/utils/getBlochHeight';

@Injectable()
export class LeaderboardSnapshotService {
  private readonly logger = new Logger(LeaderboardSnapshotService.name);
  private isRunning = false;

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
      await this.refreshWindow('7d');
      await this.refreshWindow('30d');
      await this.refreshWindow('all');
    } catch (e) {
      this.logger.error(
        `Failed to refresh leaderboard snapshots: ${(e as Error).message}`,
        (e as Error).stack,
      );
    } finally {
      this.isRunning = false;
    }
  }

  private async refreshWindow(window: LeaderboardWindow): Promise<void> {
    this.logger.log(`Recomputing leaderboard snapshots for window=${window}`);
    const items = await this.computeWindow(window, 100);

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

  private getWindowRange(window: LeaderboardWindow): {
    start?: Date;
    end: Date;
  } {
    const end = new Date();
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

  /**
   * Heavy computation: build full leaderboard for a window.
   * Runs only in background, never on request path.
   */
  private async computeWindow(
    window: LeaderboardWindow,
    maxCandidates: number,
  ): Promise<LeaderboardItem[]> {
    const { start, end } = this.getWindowRange(window);

    // Top candidate addresses by all-time USD volume
    const txTop = await this.transactionsRepository
      .createQueryBuilder('t')
      .select('t.address', 'address')
      .addSelect(
        "COALESCE(SUM(CAST(CASE WHEN lower(t.amount->>'usd') = 'nan' THEN NULL ELSE t.amount->>'usd' END AS DECIMAL)), 0)",
        'volume_usd',
      )
      .groupBy('t.address')
      .orderBy('volume_usd', 'DESC')
      .limit(maxCandidates)
      .getRawMany<{ address: string; volume_usd: string }>();
    const candidateAddresses = txTop.map((r) => r.address);

    if (!candidateAddresses.length) {
      return [];
    }

    // Load basic account meta
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

    // Created tokens (lifetime)
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

    // Owned trends count
    const ownedRaw = await this.tokenHolderRepository
      .createQueryBuilder('th')
      .select('th.address', 'address')
      .addSelect('COUNT(DISTINCT th.aex9_address)', 'owned_count')
      .where('th.address IN (:...addresses)', { addresses: candidateAddresses })
      .andWhere('CAST(th.balance AS DECIMAL) > 0')
      .groupBy('th.address')
      .getRawMany<{ address: string; owned_count: string }>();
    const ownedByAddress = new Map(ownedRaw.map((r) => [r.address, r]));

    // Precompute sample timestamps and corresponding block heights for this window
    const endMs = end.getTime();
    const startMs = start ? start.getTime() : endMs;
    const durationMs = Math.max(endMs - startMs, 1);
    const pointCount = window === '7d' ? 8 : window === '30d' ? 12 : 24;
    const sampleTimestamps: number[] = [];
    for (let i = 0; i < pointCount; i++) {
      const ratio = i / (pointCount - 1);
      const t = startMs + durationMs * ratio;
      sampleTimestamps.push(Math.floor(t));
    }

    const sampleHeights: number[] = [];
    let previousHeight: number | undefined = undefined;
    for (const ts of sampleTimestamps) {
      const h = await timestampToAeHeight(ts, previousHeight, this.dataSource);
      sampleHeights.push(h);
      previousHeight = h;
    }

    const concurrency = 8;
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
        // Sample AUM at each precomputed block height
        const spark: Array<[number, number]> = [];
        let lastPnl: TokenPnlResult | null = null;

        for (let i = 0; i < sampleHeights.length; i++) {
          const h = sampleHeights[i];
          const ts = sampleTimestamps[i];
          const pnl: TokenPnlResult =
            await this.bclPnlService.calculateTokenPnls(address, h);
          lastPnl = pnl;
          const aumUsd = pnl.totalCurrentValueUsd;
          spark.push([ts, Math.max(aumUsd, 0)]);
        }

        if (!spark.length || !lastPnl) {
          return;
        }

        // Ensure chronological
        spark.sort((a, b) => a[0] - b[0]);

        const aumStartSpark = spark[0][1];
        const aumEndUsd = spark[spark.length - 1][1];

        let pnlWindowUsd = aumEndUsd - aumStartSpark;
        let roiWindowPct =
          aumStartSpark > 0 ? (pnlWindowUsd / aumStartSpark) * 100 : 0;

        // For "all" window, use true all-time ROI from PNL data
        if (window === 'all') {
          const totalGainUsd = lastPnl.totalGainUsd;
          const totalCostBasisUsd = lastPnl.totalCostBasisUsd;
          const totalGainAe = lastPnl.totalGainAe;
          const totalCostBasisAe = lastPnl.totalCostBasisAe;

          pnlWindowUsd = totalGainUsd;
          if (totalCostBasisUsd > 0) {
            roiWindowPct = (totalGainUsd / totalCostBasisUsd) * 100;
          } else if (totalCostBasisAe > 0) {
            roiWindowPct = (totalGainAe / totalCostBasisAe) * 100;
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
        const mddPct = maxDrawdown * 100;

        seriesByAddress.set(address, spark);
        metricsIntermediate.push({
          address,
          aum_usd: aumEndUsd,
          pnl_usd: pnlWindowUsd,
          roi_pct: roiWindowPct,
          mdd_pct: mddPct,
        });
      } catch (e) {
        this.logger.warn(
          `Failed to compute window PNL for ${address}: ${(e as Error).message}`,
        );
      }
    });

    const queue = [...tasks];
    const runners: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      const runner = (async () => {
        while (queue.length) {
          const job = queue.shift();
          if (job) await job();
        }
      })();
      runners.push(runner);
    }
    await Promise.all(runners);

    const items: LeaderboardItem[] = metricsIntermediate.map((m) => {
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

    return items;
  }
}
