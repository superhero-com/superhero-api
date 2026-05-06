import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import moment from 'moment';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Post } from '@/social/entities/post.entity';
import {
  BclPnlService,
  DailyPnlWindow,
} from '@/account/services/bcl-pnl.service';

export interface ChallengeAnalyticsRow {
  address: string;
  date: string; // YYYY-MM-DD
  total_posts: number;
  total_trades: number;
  total_volume_ae: number;
  created_tokens: number;
  pnl_ae: number;
  pnl_usd: number;
}

@Injectable()
export class ChallengeAnalyticsService {
  private readonly logger = new Logger(ChallengeAnalyticsService.name);

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
    private readonly bclPnlService: BclPnlService,
  ) {}

  async getChallengeAnalytics(
    addresses: string[],
    startDate: Date,
    endDate: Date,
  ): Promise<ChallengeAnalyticsRow[]> {
    if (addresses.length === 0) {
      return [];
    }

    const startOfRange = moment(startDate).startOf('day').toDate();
    const endOfRange = moment(endDate).endOf('day').toDate();

    // List of day keys (YYYY-MM-DD) covered by the range, used for zero-fill.
    const dayKeys = this.buildDayKeys(startOfRange, endOfRange);

    // Initialise the (address × day) grid with zero rows so every cell exists.
    const grid = new Map<string, Map<string, ChallengeAnalyticsRow>>();
    for (const address of addresses) {
      const dayMap = new Map<string, ChallengeAnalyticsRow>();
      for (const dayKey of dayKeys) {
        dayMap.set(dayKey, {
          address,
          date: dayKey,
          total_posts: 0,
          total_trades: 0,
          total_volume_ae: 0,
          created_tokens: 0,
          pnl_ae: 0,
          pnl_usd: 0,
        });
      }
      grid.set(address, dayMap);
    }

    // Fetch all three data sources in parallel.
    const [postsRows, txRows, pnlByAddress] = await Promise.all([
      this.fetchPostsPerDay(addresses, startOfRange, endOfRange),
      this.fetchTransactionsPerDay(addresses, startOfRange, endOfRange),
      this.fetchPnlPerDayPerAddress(addresses, startOfRange, endOfRange),
    ]);

    for (const row of postsRows) {
      const dayMap = grid.get(row.address);
      const cell = dayMap?.get(row.date);
      if (cell) {
        cell.total_posts = row.total_posts;
      }
    }

    for (const row of txRows) {
      const dayMap = grid.get(row.address);
      const cell = dayMap?.get(row.date);
      if (cell) {
        cell.total_trades = row.total_trades;
        cell.created_tokens = row.created_tokens;
        cell.total_volume_ae = row.total_volume_ae;
      }
    }

    for (const [address, dayPnl] of pnlByAddress.entries()) {
      const dayMap = grid.get(address);
      if (!dayMap) continue;
      for (const [dayKey, pnl] of dayPnl.entries()) {
        const cell = dayMap.get(dayKey);
        if (cell) {
          cell.pnl_ae = pnl.ae;
          cell.pnl_usd = pnl.usd;
        }
      }
    }

    // Flatten back into a sorted array (address asc, then date asc).
    const flat: ChallengeAnalyticsRow[] = [];
    for (const address of addresses) {
      const dayMap = grid.get(address)!;
      for (const dayKey of dayKeys) {
        flat.push(dayMap.get(dayKey)!);
      }
    }

    return flat;
  }

  private buildDayKeys(startOfRange: Date, endOfRange: Date): string[] {
    const keys: string[] = [];
    const cursor = moment(startOfRange).startOf('day');
    const end = moment(endOfRange).startOf('day');
    while (cursor.isSameOrBefore(end)) {
      keys.push(cursor.format('YYYY-MM-DD'));
      cursor.add(1, 'day');
    }
    return keys;
  }

  private async fetchPostsPerDay(
    addresses: string[],
    startOfRange: Date,
    endOfRange: Date,
  ): Promise<Array<{ address: string; date: string; total_posts: number }>> {
    const rows: Array<{
      day: Date;
      sender_address: string;
      total_posts: string | number;
    }> = await this.postRepository.query(
      `SELECT
         date_trunc('day', created_at) AS day,
         sender_address,
         COUNT(*) FILTER (WHERE post_id IS NULL)::int AS total_posts
       FROM posts
       WHERE created_at BETWEEN $1 AND $2
         AND is_hidden = false
         AND sender_address = ANY($3::text[])
       GROUP BY day, sender_address`,
      [startOfRange, endOfRange, addresses],
    );

    return rows.map((row) => ({
      address: row.sender_address,
      date: moment(row.day).format('YYYY-MM-DD'),
      total_posts: Number(row.total_posts ?? 0),
    }));
  }

  private async fetchTransactionsPerDay(
    addresses: string[],
    startOfRange: Date,
    endOfRange: Date,
  ): Promise<
    Array<{
      address: string;
      date: string;
      total_trades: number;
      created_tokens: number;
      total_volume_ae: number;
    }>
  > {
    const rows: Array<{
      day: Date;
      address: string;
      total_trades: string | number;
      created_tokens: string | number;
      total_volume_ae: string | number | null;
    }> = await this.transactionRepository.query(
      `SELECT
         date_trunc('day', created_at) AS day,
         address,
         COUNT(*) FILTER (WHERE tx_type IN ('buy','sell'))::int        AS total_trades,
         COUNT(*) FILTER (WHERE tx_type = 'create_community')::int     AS created_tokens,
         COALESCE(SUM(
           CASE
             WHEN tx_type IN ('buy','sell','create_community')
               THEN CAST(NULLIF(amount->>'ae','NaN') AS DECIMAL)
             ELSE 0
           END
         ), 0) AS total_volume_ae
       FROM transactions
       WHERE created_at BETWEEN $1 AND $2
         AND address = ANY($3::text[])
       GROUP BY day, address`,
      [startOfRange, endOfRange, addresses],
    );

    return rows.map((row) => ({
      address: row.address,
      date: moment(row.day).format('YYYY-MM-DD'),
      total_trades: Number(row.total_trades ?? 0),
      created_tokens: Number(row.created_tokens ?? 0),
      total_volume_ae: Number(row.total_volume_ae ?? 0),
    }));
  }

  /**
   * For each address, compute REALIZED PnL per day in the range using
   * `BclPnlService.calculateDailyPnlBatch` (one batched SQL per address).
   *
   * Each day's window is [startOfDay, endOfDay) in epoch ms; PnL for the
   * window only includes sells closed within that window, valued against the
   * all-time average cost of the token (so cost basis isn't truncated by the
   * range start).
   */
  private async fetchPnlPerDayPerAddress(
    addresses: string[],
    startOfRange: Date,
    endOfRange: Date,
  ): Promise<Map<string, Map<string, { ae: number; usd: number }>>> {
    const dayKeys = this.buildDayKeys(startOfRange, endOfRange);
    if (dayKeys.length === 0) {
      return new Map();
    }

    // Build one set of windows up-front; we reuse it for every address.
    const windows: DailyPnlWindow[] = dayKeys.map((dayKey) => {
      const dayStart = moment(dayKey).startOf('day');
      const dayEnd = moment(dayKey).endOf('day');
      return {
        dayStartTs: dayStart.valueOf(),
        snapshotTs: dayEnd.valueOf(),
      };
    });

    const result = new Map<string, Map<string, { ae: number; usd: number }>>();

    await Promise.all(
      addresses.map(async (address) => {
        try {
          const batch = await this.bclPnlService.calculateDailyPnlBatch(
            address,
            windows,
          );
          // Index windows by their day key so we can look them up cheaply.
          const winByDay = new Map<string, DailyPnlWindow>();
          for (const win of windows) {
            winByDay.set(moment(win.snapshotTs).format('YYYY-MM-DD'), win);
          }
          const dayMap = new Map<string, { ae: number; usd: number }>();
          for (const dayKey of dayKeys) {
            const win = winByDay.get(dayKey);
            if (!win) continue;
            const tokenPnl = batch.get(win.snapshotTs);
            if (!tokenPnl) continue;
            dayMap.set(dayKey, {
              ae: Number(tokenPnl.totalGainAe ?? 0),
              usd: Number(tokenPnl.totalGainUsd ?? 0),
            });
          }
          result.set(address, dayMap);
        } catch (error: any) {
          this.logger.error(
            `Error computing daily PnL for address ${address}`,
            error,
            error?.stack,
          );
          result.set(address, new Map());
        }
      }),
    );

    return result;
  }
}
