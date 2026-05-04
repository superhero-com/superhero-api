import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { batchTimestampToAeHeight } from '@/utils/getBlochHeight';
import { Account } from '../entities/account.entity';
import { AccountLeaderboardSnapshot } from '../entities/account-leaderboard-snapshot.entity';
import { BclPnlService } from './bcl-pnl.service';
import {
  GetLeadersParams,
  LEADERBOARD_SNAPSHOT_MAX_CANDIDATES,
  LeaderboardItem,
  LeaderboardSortBy,
  LeaderboardSortDir,
  LeaderboardTimeFilter,
  LeaderboardWindow,
} from './leaderboard.types';

interface LeaderboardRow {
  address: string;
  chain_name: string | null;
  aum_usd: number | string;
  pnl_usd: number | string;
  roi_pct: number | string;
  mdd_pct: number | string;
  buy_count: number | string;
  sell_count: number | string;
  created_tokens_count: number | string;
  owned_trends_count: number | string;
  portfolio_value_usd_sparkline: Array<[number, number]> | null;
  active_buy_count?: number | string | null;
  active_sell_count?: number | string | null;
  total_count: number | string;
}

interface LeaderboardCountRow {
  total_count: number | string;
}

interface EventActiveAddressRow {
  address: string;
  buy_count: number | string;
  sell_count: number | string;
  volume_usd: number | string;
}

const SORT_COLUMNS: Record<LeaderboardSortBy, string> = {
  pnl: 'snap.pnl_usd',
  roi: 'snap.roi_pct',
  mdd: 'snap.mdd_pct',
  aum: 'snap.aum_usd',
};

const VALID_SORT_DIRECTIONS: ReadonlySet<LeaderboardSortDir> = new Set([
  'ASC',
  'DESC',
]);
const MAX_TIME_FILTER_DAYS = 14;
const MAX_TIME_FILTER_MS = MAX_TIME_FILTER_DAYS * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 18;
const MAX_LIMIT = 50;

@Injectable()
export class LeaderboardService {
  constructor(
    @InjectRepository(AccountLeaderboardSnapshot)
    private readonly snapshotRepository: Repository<AccountLeaderboardSnapshot>,
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    private readonly bclPnlService: BclPnlService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async getLeaders(params: GetLeadersParams): Promise<{
    items: LeaderboardItem[];
    totalCandidates: number;
    page: number;
    limit: number;
    window: LeaderboardWindow;
    sortBy: LeaderboardSortBy;
    sortDir: LeaderboardSortDir;
    timeFilter?: LeaderboardTimeFilter;
  }> {
    const window = params.window ?? '7d';
    const sortBy = params.sortBy ?? 'pnl';
    const sortDir = this.resolveSortDir(params.sortDir, sortBy);
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.max(
      1,
      Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    );
    const minAumUsd = params.minAumUsd ?? 1; // default: exclude ~0 AUM
    const timeFilter = this.normalizeTimeFilter(params);
    const offset = (page - 1) * limit;

    if (timeFilter) {
      const { items, total } = await this.getEventPerformanceLeaders({
        timeFilter,
        sortBy,
        sortDir,
        limit,
        offset,
        minAumUsd,
        maxCandidates: Math.max(
          offset + limit,
          Math.min(
            params.maxCandidates ?? LEADERBOARD_SNAPSHOT_MAX_CANDIDATES,
            500,
          ),
        ),
        points: params.points,
      });

      return {
        items,
        totalCandidates: total,
        page,
        limit,
        window,
        sortBy,
        sortDir,
        timeFilter,
      };
    }

    const { rows, total } = await this.queryLeaderboardRows({
      window,
      sortBy,
      sortDir,
      minAumUsd,
      limit,
      offset,
      timeFilter,
    });

    const items: LeaderboardItem[] = rows.map((row) => {
      const item: LeaderboardItem = {
        address: row.address,
        chain_name: row.chain_name ?? null,
        aum_usd: Number(row.aum_usd),
        pnl_usd: Number(row.pnl_usd),
        roi_pct: Number(row.roi_pct),
        mdd_pct: Number(row.mdd_pct),
        buy_count: Number(row.buy_count),
        sell_count: Number(row.sell_count),
        created_tokens_count: Number(row.created_tokens_count),
        owned_trends_count: Number(row.owned_trends_count),
        portfolio_value_usd_sparkline: row.portfolio_value_usd_sparkline || [],
      };
      if (timeFilter) {
        item.active_period = {
          buy_count: Number(row.active_buy_count ?? 0),
          sell_count: Number(row.active_sell_count ?? 0),
        };
      }
      return item;
    });

    return {
      items,
      totalCandidates: total,
      page,
      limit,
      window,
      sortBy,
      sortDir,
      timeFilter,
    };
  }

  /**
   * Issues a single SQL statement that returns paginated rows and inlines the
   * unrestricted total via `COUNT(*) OVER()`. Avoids running the (potentially
   * expensive) `active_accounts` CTE twice on the hot path.
   *
   * Cost of the inline COUNT:
   * `COUNT(*) OVER()` evaluates the full filtered set (post-CTE, pre-LIMIT).
   * For this endpoint that set is upper-bounded by
   * `LEADERBOARD_SNAPSHOT_MAX_CANDIDATES` rows per window (snapshot job caps
   * how many rows it writes), so the COUNT is O(≤N) — essentially free —
   * regardless of caller pagination. If that ceiling is ever raised beyond
   * a few thousand, switch to cursor pagination or drop `totalItems` from
   * the response, otherwise the COUNT will start to dominate.
   *
   * Performance prerequisite for the time-filter path:
   * the `active_accounts` CTE scans `transactions` over a ≤7d window. The
   * supporting indexes are described in
   * `docs/leaderboard-time-filter-manual-migration.sql`; that DDL must be
   * applied **before** the time-filter feature is exposed in production.
   *
   * The only case in which we cannot read the total from the rows themselves
   * is an empty page beyond the end of the result (e.g. `page=99` of a 7-row
   * result). In that case we issue a single fallback `COUNT(*)` query — which
   * is the only path that re-evaluates the CTE.
   */
  private async queryLeaderboardRows(params: {
    window: LeaderboardWindow;
    sortBy: LeaderboardSortBy;
    sortDir: LeaderboardSortDir;
    minAumUsd: number;
    limit: number;
    offset: number;
    timeFilter?: LeaderboardTimeFilter;
  }): Promise<{ rows: LeaderboardRow[]; total: number }> {
    // Defensive: sortBy/sortDir should already be validated by the controller's
    // class-validator DTO, but we still look them up via a fixed map / set
    // because they're string-interpolated into SQL below.
    const sortColumn = SORT_COLUMNS[params.sortBy];
    if (!sortColumn) {
      throw new BadRequestException(
        'sortBy must be one of: pnl, roi, mdd, aum',
      );
    }
    if (!VALID_SORT_DIRECTIONS.has(params.sortDir)) {
      throw new BadRequestException('sortDir must be one of: ASC, DESC');
    }

    const baseQueryParams: Array<string | number | Date> = [];
    const pushParam = (value: string | number | Date): string => {
      baseQueryParams.push(value);
      return `$${baseQueryParams.length}`;
    };

    const windowParam = pushParam(params.window);
    const minAumParam = pushParam(params.minAumUsd);

    let activeAccountsCte = '';
    let activeAccountsJoin = '';
    let activeBuyCountSelect = 'NULL';
    let activeSellCountSelect = 'NULL';

    if (params.timeFilter) {
      const startParam = pushParam(params.timeFilter.start);
      const endParam = pushParam(params.timeFilter.end);
      // The EXISTS clause restricts the transactions scan to addresses that are
      // already eligible (in the window with sufficient AUM). The same window
      // and minAum predicates are reapplied in the outer query below; if either
      // is changed, change both places.
      activeAccountsCte = `
        WITH active_accounts AS (
          SELECT
            t.address,
            COUNT(*) FILTER (WHERE t.tx_type = 'buy')::int AS buy_count,
            COUNT(*) FILTER (WHERE t.tx_type = 'sell')::int AS sell_count
          FROM transactions t
          WHERE t.tx_type IN ('buy', 'sell')
            AND t.created_at >= ${startParam}
            AND t.created_at < ${endParam}
            AND EXISTS (
              SELECT 1
              FROM account_leaderboard_snapshots eligible
              WHERE eligible.window = ${windowParam}
                AND eligible.aum_usd >= ${minAumParam}
                AND eligible.address = t.address
            )
          GROUP BY t.address
        )
      `;
      activeAccountsJoin =
        'INNER JOIN active_accounts active ON active.address = snap.address';
      activeBuyCountSelect = 'active.buy_count';
      activeSellCountSelect = 'active.sell_count';
    }

    const dataQueryParams = [...baseQueryParams, params.limit, params.offset];
    const limitParam = `$${baseQueryParams.length + 1}`;
    const offsetParam = `$${baseQueryParams.length + 2}`;

    const rows = (await this.snapshotRepository.query(
      `
        ${activeAccountsCte}
        SELECT
          snap.address,
          snap.chain_name,
          snap.aum_usd,
          snap.pnl_usd,
          snap.roi_pct,
          snap.mdd_pct,
          snap.buy_count,
          snap.sell_count,
          snap.created_tokens_count,
          snap.owned_trends_count,
          snap.portfolio_value_usd_sparkline,
          ${activeBuyCountSelect} AS active_buy_count,
          ${activeSellCountSelect} AS active_sell_count,
          (COUNT(*) OVER())::int AS total_count
        FROM account_leaderboard_snapshots snap
        ${activeAccountsJoin}
        WHERE snap.window = ${windowParam}
          AND snap.aum_usd >= ${minAumParam}
        ORDER BY ${sortColumn} ${params.sortDir}, snap.address ASC
        LIMIT ${limitParam}
        OFFSET ${offsetParam}
      `,
      dataQueryParams,
    )) as LeaderboardRow[];

    if (rows.length > 0) {
      return { rows, total: Number(rows[0].total_count) };
    }
    if (params.offset === 0) {
      // Empty result set on the first page → total is 0; no fallback required.
      return { rows, total: 0 };
    }

    // Empty page beyond the end of the result. Pay for one extra COUNT(*).
    const countRows = (await this.snapshotRepository.query(
      `
        ${activeAccountsCte}
        SELECT COUNT(*)::int AS total_count
        FROM account_leaderboard_snapshots snap
        ${activeAccountsJoin}
        WHERE snap.window = ${windowParam}
          AND snap.aum_usd >= ${minAumParam}
      `,
      baseQueryParams,
    )) as LeaderboardCountRow[];

    return {
      rows,
      total: countRows.length ? Number(countRows[0].total_count) : 0,
    };
  }

  private async getEventPerformanceLeaders(params: {
    timeFilter: LeaderboardTimeFilter;
    sortBy: LeaderboardSortBy;
    sortDir: LeaderboardSortDir;
    limit: number;
    offset: number;
    minAumUsd: number;
    maxCandidates: number;
    points?: number;
  }): Promise<{ items: LeaderboardItem[]; total: number }> {
    const activeRows = await this.queryActiveAddressRows(
      params.timeFilter,
      params.maxCandidates,
    );
    if (activeRows.length === 0) {
      return { items: [], total: 0 };
    }

    const activeByAddress = new Map(
      activeRows.map((row) => [row.address, row]),
    );
    const addresses = activeRows.map((row) => row.address);
    const accounts = await this.accountRepository.find({
      where: { address: In(addresses) },
    });
    const accountByAddress = new Map(
      accounts.map((account) => [account.address, account]),
    );

    const sampleTimestamps = this.buildEventSampleTimestamps(
      params.timeFilter,
      params.points,
    );
    const heights = await this.resolveSampleHeights(sampleTimestamps);
    const eventItems = await this.computeEventItems({
      addresses,
      activeByAddress,
      accountByAddress,
      sampleTimestamps,
      heights,
    });

    const eligibleItems = eventItems.filter(
      (item) => item.aum_usd >= params.minAumUsd,
    );
    eligibleItems.sort((a, b) =>
      this.compareLeaderboardItems(a, b, params.sortBy, params.sortDir),
    );

    return {
      items: eligibleItems.slice(params.offset, params.offset + params.limit),
      total: eligibleItems.length,
    };
  }

  private async queryActiveAddressRows(
    timeFilter: LeaderboardTimeFilter,
    maxCandidates: number,
  ): Promise<EventActiveAddressRow[]> {
    return (await this.transactionsRepository.query(
      `
        SELECT
          t.address,
          COUNT(*) FILTER (WHERE t.tx_type = 'buy')::int AS buy_count,
          COUNT(*) FILTER (WHERE t.tx_type = 'sell')::int AS sell_count,
          COALESCE(
            SUM(
              CASE
                WHEN NULLIF(NULLIF(NULLIF(t.amount->>'usd', 'NaN'), 'null'), '') IS NULL THEN 0
                ELSE CAST(NULLIF(NULLIF(NULLIF(t.amount->>'usd', 'NaN'), 'null'), '') AS DECIMAL)
              END
            ),
            0
          ) AS volume_usd
        FROM transactions t
        WHERE t.tx_type IN ('buy', 'sell')
          AND t.created_at >= $1
          AND t.created_at < $2
        GROUP BY t.address
        ORDER BY volume_usd DESC, t.address ASC
        LIMIT $3
      `,
      [timeFilter.start, timeFilter.end, maxCandidates],
    )) as EventActiveAddressRow[];
  }

  private buildEventSampleTimestamps(
    timeFilter: LeaderboardTimeFilter,
    points?: number,
  ): number[] {
    const pointCount = Math.max(2, Math.min(points ?? 8, 12));
    const startMs = timeFilter.start.getTime();
    const endMs = timeFilter.end.getTime();
    const durationMs = Math.max(endMs - startMs, 1);

    return Array.from({ length: pointCount }, (_, index) => {
      const ratio = index / (pointCount - 1);
      return Math.floor(startMs + durationMs * ratio);
    });
  }

  private async resolveSampleHeights(timestamps: number[]): Promise<number[]> {
    const heightByTimestamp = await batchTimestampToAeHeight(
      timestamps,
      this.dataSource,
    );
    return timestamps.map((timestamp) => {
      const height = heightByTimestamp.get(timestamp);
      if (height === undefined) {
        throw new BadRequestException(
          'Unable to resolve block heights for the requested time period',
        );
      }
      return height;
    });
  }

  private async computeEventItems(params: {
    addresses: string[];
    activeByAddress: Map<string, EventActiveAddressRow>;
    accountByAddress: Map<string, Account>;
    sampleTimestamps: number[];
    heights: number[];
  }): Promise<LeaderboardItem[]> {
    const items: LeaderboardItem[] = [];
    const concurrency = 8;
    const queue = [...params.addresses];

    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const address = queue.shift();
        if (!address) {
          continue;
        }

        const item = await this.computeEventItem({
          address,
          activeRow: params.activeByAddress.get(address),
          account: params.accountByAddress.get(address),
          sampleTimestamps: params.sampleTimestamps,
          heights: params.heights,
        });
        if (item) {
          items.push(item);
        }
      }
    });

    await Promise.all(workers);
    return items;
  }

  private async computeEventItem(params: {
    address: string;
    activeRow?: EventActiveAddressRow;
    account?: Account;
    sampleTimestamps: number[];
    heights: number[];
  }): Promise<LeaderboardItem | undefined> {
    const pnlByHeight = await this.bclPnlService.calculateTokenPnlsBatch(
      params.address,
      params.heights,
    );
    const sparkline = params.heights.map((height, index): [number, number] => {
      const pnl = pnlByHeight.get(height);
      return [
        params.sampleTimestamps[index],
        Math.max(pnl?.totalCurrentValueUsd ?? 0, 0),
      ];
    });

    if (sparkline.length === 0) {
      return undefined;
    }

    const startAumUsd = sparkline[0][1];
    const endAumUsd = sparkline[sparkline.length - 1][1];
    const pnlUsd = endAumUsd - startAumUsd;
    const roiPct = startAumUsd > 0 ? (pnlUsd / startAumUsd) * 100 : 0;
    const mddPct = this.calculateMaxDrawdownPct(sparkline);
    const activeRow = params.activeRow;

    return {
      address: params.address,
      chain_name: params.account?.chain_name ?? null,
      aum_usd: endAumUsd,
      pnl_usd: pnlUsd,
      roi_pct: roiPct,
      mdd_pct: mddPct,
      buy_count: Number(activeRow?.buy_count ?? 0),
      sell_count: Number(activeRow?.sell_count ?? 0),
      created_tokens_count: 0,
      owned_trends_count: 0,
      portfolio_value_usd_sparkline: sparkline,
      volume_usd: Number(activeRow?.volume_usd ?? 0),
    };
  }

  private calculateMaxDrawdownPct(sparkline: Array<[number, number]>): number {
    let peak = Number.NEGATIVE_INFINITY;
    let maxDrawdown = 0;

    for (const [, value] of sparkline) {
      if (value > peak) {
        peak = value;
      }
      if (peak > 0) {
        maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
      }
    }

    return maxDrawdown * 100;
  }

  private compareLeaderboardItems(
    left: LeaderboardItem,
    right: LeaderboardItem,
    sortBy: LeaderboardSortBy,
    sortDir: LeaderboardSortDir,
  ): number {
    const getValue = (item: LeaderboardItem): number => {
      switch (sortBy) {
        case 'pnl':
          return item.pnl_usd;
        case 'roi':
          return item.roi_pct;
        case 'mdd':
          return item.mdd_pct;
        case 'aum':
          return item.aum_usd;
      }
    };

    const direction = sortDir === 'ASC' ? 1 : -1;
    const valueDiff = getValue(left) - getValue(right);
    if (valueDiff !== 0) {
      return valueDiff * direction;
    }
    return left.address.localeCompare(right.address);
  }

  private resolveSortDir(
    sortDir: LeaderboardSortDir | undefined,
    sortBy: LeaderboardSortBy,
  ): LeaderboardSortDir {
    if (sortDir) {
      return sortDir;
    }
    return sortBy === 'mdd' ? 'ASC' : 'DESC';
  }

  private normalizeTimeFilter(
    params: GetLeadersParams,
  ): LeaderboardTimeFilter | undefined {
    const hasStart =
      params.startDate !== undefined && params.startDate !== null;
    const hasEnd = params.endDate !== undefined && params.endDate !== null;

    if (!hasStart && !hasEnd) {
      return undefined;
    }
    if (!hasStart || !hasEnd) {
      throw new BadRequestException(
        'startDate and endDate must be provided together',
      );
    }

    const start = new Date(params.startDate as string);
    const end = new Date(params.endDate as string);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException(
        'startDate and endDate must be valid ISO 8601 timestamps',
      );
    }

    const durationMs = end.getTime() - start.getTime();
    if (durationMs <= 0) {
      throw new BadRequestException('endDate must be after startDate');
    }
    if (durationMs > MAX_TIME_FILTER_MS) {
      throw new BadRequestException(
        `Selected period cannot exceed ${MAX_TIME_FILTER_DAYS} days`,
      );
    }

    return {
      start,
      end,
    };
  }
}
