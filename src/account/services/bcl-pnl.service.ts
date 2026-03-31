import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transaction } from '@/transactions/entities/transaction.entity';

export interface DailyPnlWindow {
  /** Unix epoch milliseconds — upper bound of the day window (exclusive) */
  snapshotTs: number;
  /** Unix epoch milliseconds — lower bound of the day window (inclusive) */
  dayStartTs: number;
}

export interface TradingStatsResult {
  topWin: { ae: number; usd: number };
  unrealizedProfit: { ae: number; usd: number };
  winRate: number;
  avgDurationSeconds: number;
  totalTrades: number;
  winningTrades: number;
}

export interface TokenPnlResult {
  pnls: Record<
    string,
    {
      current_unit_price: { ae: number; usd: number };
      percentage: number;
      invested: { ae: number; usd: number };
      current_value: { ae: number; usd: number };
      gain: { ae: number; usd: number };
    }
  >;
  totalCostBasisAe: number;
  totalCostBasisUsd: number;
  totalCurrentValueAe: number;
  totalCurrentValueUsd: number;
  totalGainAe: number;
  totalGainUsd: number;
}

@Injectable()
export class BclPnlService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
  ) {}

  /**
   * Calculate PNL for each token at a specific block height
   * Returns PNL data and cost basis for each token
   * @param address - Account address
   * @param blockHeight - Block height to calculate PNL at
   * @param fromBlockHeight - Optional: If provided, only include transactions from this block height onwards (for range-based PNL)
   */
  async calculateTokenPnls(
    address: string,
    blockHeight: number,
    fromBlockHeight?: number,
  ): Promise<TokenPnlResult> {
    const tokenPnls = await this.transactionRepository.query(
      this.buildTokenPnlsQuery(fromBlockHeight),
      this.buildQueryParameters(address, blockHeight, fromBlockHeight),
    );
    return this.mapTokenPnls(
      tokenPnls,
      fromBlockHeight !== undefined && fromBlockHeight !== null,
    );
  }

  /**
   * Calculate PNL for each token across multiple block heights in a single SQL query.
   * Deduplicates heights before querying to avoid redundant work.
   *
   * @param address - Account address
   * @param blockHeights - Array of block heights to calculate PNL at
   * @param fromBlockHeight - Optional: If provided, restrict cost-basis aggregates to this range
   * @returns Map from block height to its TokenPnlResult
   */
  async calculateTokenPnlsBatch(
    address: string,
    blockHeights: number[],
    fromBlockHeight?: number,
  ): Promise<Map<number, TokenPnlResult>> {
    const uniqueHeights = [...new Set(blockHeights)];
    if (uniqueHeights.length === 0) {
      return new Map();
    }

    const rows = await this.transactionRepository.query(
      this.buildBatchTokenPnlsQuery(fromBlockHeight),
      this.buildBatchQueryParameters(address, uniqueHeights, fromBlockHeight),
    );

    return this.mapTokenPnlsBatch(rows, uniqueHeights, fromBlockHeight);
  }

  /**
   * Calculate per-day realized PnL for each token using timestamp-based windows.
   * Each window defines an isolated [dayStartTs, snapshotTs) sell range so the
   * result for each day only reflects trades closed on that specific day.
   *
   * Cumulative buy history (for average cost per token) is always taken from
   * all transactions up to snapshotTs, regardless of dayStartTs.
   *
   * @param address - Account address
   * @param windows - Per-snapshot time windows (Unix epoch ms)
   * @returns Map from snapshotTs to its TokenPnlResult
   */
  async calculateDailyPnlBatch(
    address: string,
    windows: DailyPnlWindow[],
  ): Promise<Map<number, TokenPnlResult>> {
    if (windows.length === 0) {
      return new Map();
    }

    // Pass epoch seconds (float8) — PostgreSQL to_timestamp() works in seconds
    const snapshotEpochs = windows.map((w) => w.snapshotTs / 1000);
    const dayStartEpochs = windows.map((w) => w.dayStartTs / 1000);

    const rows = await this.transactionRepository.query(
      this.buildDailyPnlQuery(),
      [address, snapshotEpochs, dayStartEpochs],
    );

    return this.mapDailyPnlBatch(rows, windows);
  }

  /**
   * Calculate aggregate trading stats for an address over a date range.
   *
   * @param address  - Account address
   * @param startDate - Start of range (inclusive)
   * @param endDate   - End of range (exclusive)
   */
  async calculateTradingStats(
    address: string,
    startDate: Date,
    endDate: Date,
  ): Promise<TradingStatsResult> {
    const rows = await this.transactionRepository.query(
      this.buildTradingStatsQuery(),
      [address, startDate, endDate],
    );

    return this.mapTradingStats(rows[0]);
  }

  private buildTradingStatsQuery(): string {
    return `
      WITH
      -- All transactions for this address, scanned once
      address_txs AS MATERIALIZED (
        SELECT sale_address, created_at, tx_type, volume, amount
        FROM transactions
        WHERE address = $1
      ),
      -- Per-token all-time aggregates needed for avg cost and current holdings
      token_agg AS (
        SELECT
          sale_address,
          COALESCE(
            SUM(CASE WHEN tx_type IN ('buy', 'create_community')
              THEN CAST(volume AS DECIMAL) ELSE 0 END) -
            SUM(CASE WHEN tx_type = 'sell'
              THEN CAST(volume AS DECIMAL) ELSE 0 END),
            0
          ) AS current_holdings,
          COALESCE(SUM(CASE WHEN tx_type IN ('buy', 'create_community')
            THEN CAST(volume AS DECIMAL) ELSE 0 END), 0) AS cum_vol_bought,
          COALESCE(SUM(CASE WHEN tx_type IN ('buy', 'create_community')
            THEN CAST(NULLIF(amount->>'ae', 'NaN') AS DECIMAL) ELSE 0 END), 0) AS cum_spent_ae,
          COALESCE(SUM(CASE WHEN tx_type IN ('buy', 'create_community')
            THEN CAST(NULLIF(amount->>'usd', 'NaN') AS DECIMAL) ELSE 0 END), 0) AS cum_spent_usd,
          MIN(CASE WHEN tx_type IN ('buy', 'create_community')
            THEN created_at ELSE NULL END) AS first_buy_at
        FROM address_txs
        GROUP BY sale_address
      ),
      -- Latest market price per token (from any trader, not just this address)
      token_price AS (
        SELECT DISTINCT ON (p.sale_address)
          p.sale_address,
          CAST(NULLIF(p.buy_price->>'ae', 'NaN') AS DECIMAL) AS unit_price_ae,
          CAST(NULLIF(p.buy_price->>'usd', 'NaN') AS DECIMAL) AS unit_price_usd
        FROM transactions p
        WHERE p.sale_address IN (
          SELECT sale_address FROM token_agg WHERE current_holdings > 0
        )
          AND p.buy_price->>'ae' IS NOT NULL
          AND p.buy_price->>'ae' NOT IN ('NaN', 'null', '')
        ORDER BY p.sale_address, p.created_at DESC
      ),
      -- Each sell transaction within the requested date range, enriched with
      -- avg cost from token_agg so we can compute per-sell realized gain.
      range_sells AS (
        SELECT
          s.sale_address,
          s.created_at AS sell_at,
          CAST(NULLIF(s.amount->>'ae', 'NaN') AS DECIMAL) AS proceeds_ae,
          CAST(NULLIF(s.amount->>'usd', 'NaN') AS DECIMAL) AS proceeds_usd,
          CAST(s.volume AS DECIMAL) AS sell_volume,
          CASE WHEN ta.cum_vol_bought > 0
            THEN (ta.cum_spent_ae / ta.cum_vol_bought) * CAST(s.volume AS DECIMAL)
            ELSE 0
          END AS cost_ae,
          CASE WHEN ta.cum_vol_bought > 0
            THEN (ta.cum_spent_usd / ta.cum_vol_bought) * CAST(s.volume AS DECIMAL)
            ELSE 0
          END AS cost_usd,
          EXTRACT(EPOCH FROM (s.created_at - ta.first_buy_at)) AS hold_secs
        FROM address_txs s
        JOIN token_agg ta ON ta.sale_address = s.sale_address
        WHERE s.tx_type = 'sell'
          AND s.created_at >= $2
          AND s.created_at < $3
      ),
      range_sells_with_gain AS (
        SELECT
          proceeds_ae - cost_ae AS gain_ae,
          proceeds_usd - cost_usd AS gain_usd,
          hold_secs
        FROM range_sells
      ),
      -- The single best sell transaction by AE gain (both AE and USD come from the same row).
      -- Using a dedicated CTE instead of independent MAX() aggregations avoids mixing
      -- AE/USD values from different trades when exchange rates differ.
      top_trade AS (
        SELECT gain_ae AS top_win_ae, gain_usd AS top_win_usd
        FROM range_sells_with_gain
        WHERE gain_ae > 0
        ORDER BY gain_ae DESC
        LIMIT 1
      ),
      -- Aggregate sell stats over the range
      sell_stats AS (
        SELECT
          COALESCE((SELECT top_win_ae FROM top_trade), 0) AS top_win_ae,
          COALESCE((SELECT top_win_usd FROM top_trade), 0) AS top_win_usd,
          COUNT(*) FILTER (WHERE gain_ae > 0) AS winning_sells,
          COUNT(*) AS total_sells,
          COALESCE(AVG(hold_secs) FILTER (WHERE hold_secs IS NOT NULL AND hold_secs >= 0), 0) AS avg_hold_secs
        FROM range_sells_with_gain
      ),
      -- Unrealized profit: all currently-held tokens regardless of purchase date
      unrealized AS (
        SELECT
          COALESCE(SUM(
            ta.current_holdings * COALESCE(tp.unit_price_ae, 0) -
            CASE WHEN ta.cum_vol_bought > 0
              THEN (ta.cum_spent_ae / ta.cum_vol_bought) * ta.current_holdings
              ELSE 0
            END
          ), 0) AS unrealized_ae,
          COALESCE(SUM(
            ta.current_holdings * COALESCE(tp.unit_price_usd, 0) -
            CASE WHEN ta.cum_vol_bought > 0
              THEN (ta.cum_spent_usd / ta.cum_vol_bought) * ta.current_holdings
              ELSE 0
            END
          ), 0) AS unrealized_usd
        FROM token_agg ta
        LEFT JOIN token_price tp ON tp.sale_address = ta.sale_address
        WHERE ta.current_holdings > 0
      )
      SELECT
        ss.top_win_ae,
        ss.top_win_usd,
        ss.winning_sells,
        ss.total_sells,
        ss.avg_hold_secs,
        u.unrealized_ae,
        u.unrealized_usd
      FROM sell_stats ss
      CROSS JOIN unrealized u
    `;
  }

  private mapTradingStats(row: Record<string, any> | undefined): TradingStatsResult {
    if (!row) {
      return {
        topWin: { ae: 0, usd: 0 },
        unrealizedProfit: { ae: 0, usd: 0 },
        winRate: 0,
        avgDurationSeconds: 0,
        totalTrades: 0,
        winningTrades: 0,
      };
    }

    const totalTrades = Number(row.total_sells || 0);
    const winningTrades = Number(row.winning_sells || 0);
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

    return {
      topWin: {
        ae: Number(row.top_win_ae || 0),
        usd: Number(row.top_win_usd || 0),
      },
      unrealizedProfit: {
        ae: Number(row.unrealized_ae || 0),
        usd: Number(row.unrealized_usd || 0),
      },
      winRate,
      avgDurationSeconds: Number(row.avg_hold_secs || 0),
      totalTrades,
      winningTrades,
    };
  }

  private buildBatchTokenPnlsQuery(fromBlockHeight?: number): string {
    const hasRange = fromBlockHeight !== undefined && fromBlockHeight !== null;
    const rangeCondition = hasRange ? ' AND tx.block_height >= $3' : '';

    // When a range is active, also gather cumulative (all-time) buy totals so we
    // can compute the average cost per token across the full history. This is
    // needed to price the cost basis of tokens that were sold during the range
    // but were originally purchased before it started.
    const cumulativeColumns = hasRange
      ? `,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')
                  THEN CAST(tx.volume AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS cumulative_volume_bought,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS cumulative_amount_spent_ae,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS cumulative_amount_spent_usd`
      : '';

    const cumulativeSelectColumns = hasRange
      ? `
        agg.cumulative_volume_bought,
        agg.cumulative_amount_spent_ae,
        agg.cumulative_amount_spent_usd,`
      : '';

    return `
      WITH heights AS (
        SELECT unnest($2::int[]) AS snapshot_height
      ),
      -- Scan the address's transactions exactly once and materialise the result.
      -- Without MATERIALIZED PostgreSQL 12+ may inline this CTE, re-executing
      -- the index scan for every row in heights (N × index-scan instead of 1).
      -- With MATERIALIZED the planner builds a hash table once in work_mem and
      -- probes it for each snapshot height, avoiding repeated I/O.
      address_txs AS MATERIALIZED (
        SELECT sale_address, block_height, tx_type, volume, amount
        FROM transactions
        WHERE address = $1
      ),
      aggregated_holdings AS (
        SELECT
          h.snapshot_height,
          tx.sale_address AS sale_address,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')
                  THEN CAST(tx.volume AS DECIMAL)
                ELSE 0
              END
            ) -
            COALESCE(
              SUM(
                CASE
                  WHEN tx.tx_type = 'sell'
                    THEN CAST(tx.volume AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            ),
            0
          ) AS current_holdings,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')${rangeCondition}
                  THEN CAST(tx.volume AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_volume_bought,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')${rangeCondition}
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_amount_spent_ae,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')${rangeCondition}
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_amount_spent_usd,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type = 'sell'${rangeCondition}
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_amount_received_ae,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type = 'sell'${rangeCondition}
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_amount_received_usd,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type = 'sell'${rangeCondition}
                  THEN CAST(tx.volume AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_volume_sold${cumulativeColumns}
        FROM heights h
        JOIN address_txs tx ON tx.block_height < h.snapshot_height
        GROUP BY h.snapshot_height, tx.sale_address
      )
      SELECT
        agg.snapshot_height,
        agg.sale_address,
        agg.current_holdings,
        agg.total_volume_bought,
        agg.total_amount_spent_ae,
        agg.total_amount_spent_usd,
        agg.total_amount_received_ae,
        agg.total_amount_received_usd,
        agg.total_volume_sold,${cumulativeSelectColumns}
        ae_price.current_unit_price_ae,
        usd_price.current_unit_price_usd
      FROM aggregated_holdings agg
      LEFT JOIN LATERAL (
        SELECT CAST(NULLIF(p.buy_price->>'ae', 'NaN') AS DECIMAL) AS current_unit_price_ae
        FROM transactions p
        WHERE p.sale_address = agg.sale_address
          AND p.block_height <= agg.snapshot_height
          AND p.buy_price->>'ae' IS NOT NULL
          AND p.buy_price->>'ae' NOT IN ('NaN', 'null', '')
        ORDER BY p.block_height DESC, p.created_at DESC
        LIMIT 1
      ) ae_price ON true
      LEFT JOIN LATERAL (
        SELECT CAST(NULLIF(p.buy_price->>'usd', 'NaN') AS DECIMAL) AS current_unit_price_usd
        FROM transactions p
        WHERE p.sale_address = agg.sale_address
          AND p.block_height <= agg.snapshot_height
          AND p.buy_price->>'usd' IS NOT NULL
          AND p.buy_price->>'usd' NOT IN ('NaN', 'null', '')
        ORDER BY p.block_height DESC, p.created_at DESC
        LIMIT 1
      ) usd_price ON true
      WHERE agg.current_holdings > 0
         OR agg.total_volume_bought > 0
         OR agg.total_volume_sold > 0
    `;
  }

  private buildBatchQueryParameters(
    address: string,
    blockHeights: number[],
    fromBlockHeight?: number,
  ): Array<string | number | number[]> {
    return fromBlockHeight !== undefined && fromBlockHeight !== null
      ? [address, blockHeights, fromBlockHeight]
      : [address, blockHeights];
  }

  private buildDailyPnlQuery(): string {
    return `
      WITH snapshots AS (
        SELECT
          to_timestamp(unnest($2::float8[])) AS snapshot_ts,
          to_timestamp(unnest($3::float8[])) AS day_start_ts
      ),
      -- Scan the address's transactions exactly once.
      address_txs AS MATERIALIZED (
        SELECT sale_address, created_at, tx_type, volume, amount
        FROM transactions
        WHERE address = $1
      ),
      aggregated AS (
        SELECT
          s.snapshot_ts,
          tx.sale_address,
          -- All-time holdings up to snapshot (for portfolio value display)
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community') AND tx.created_at < s.snapshot_ts
                  THEN CAST(tx.volume AS DECIMAL)
                ELSE 0
              END
            ) -
            COALESCE(
              SUM(
                CASE
                  WHEN tx.tx_type = 'sell' AND tx.created_at < s.snapshot_ts
                    THEN CAST(tx.volume AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            ),
            0
          ) AS current_holdings,
          -- Cumulative buy volume/cost (all-time up to snapshot, for avg cost per token)
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community') AND tx.created_at < s.snapshot_ts
                  THEN CAST(tx.volume AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS cumulative_volume_bought,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community') AND tx.created_at < s.snapshot_ts
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS cumulative_amount_spent_ae,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community') AND tx.created_at < s.snapshot_ts
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS cumulative_amount_spent_usd,
          -- Sells only within [day_start_ts, snapshot_ts)
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type = 'sell'
                  AND tx.created_at >= s.day_start_ts
                  AND tx.created_at < s.snapshot_ts
                  THEN CAST(tx.volume AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_volume_sold,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type = 'sell'
                  AND tx.created_at >= s.day_start_ts
                  AND tx.created_at < s.snapshot_ts
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_amount_received_ae,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type = 'sell'
                  AND tx.created_at >= s.day_start_ts
                  AND tx.created_at < s.snapshot_ts
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_amount_received_usd
        FROM snapshots s
        JOIN address_txs tx ON tx.created_at < s.snapshot_ts
        GROUP BY s.snapshot_ts, tx.sale_address
      )
      SELECT
        (EXTRACT(EPOCH FROM agg.snapshot_ts) * 1000)::bigint AS snapshot_ts_ms,
        agg.sale_address,
        agg.current_holdings,
        agg.cumulative_volume_bought,
        agg.cumulative_amount_spent_ae,
        agg.cumulative_amount_spent_usd,
        agg.total_volume_sold,
        agg.total_amount_received_ae,
        agg.total_amount_received_usd,
        ae_price.current_unit_price_ae,
        usd_price.current_unit_price_usd
      FROM aggregated agg
      LEFT JOIN LATERAL (
        SELECT CAST(NULLIF(p.buy_price->>'ae', 'NaN') AS DECIMAL) AS current_unit_price_ae
        FROM transactions p
        WHERE p.sale_address = agg.sale_address
          AND p.created_at < agg.snapshot_ts
          AND p.buy_price->>'ae' IS NOT NULL
          AND p.buy_price->>'ae' NOT IN ('NaN', 'null', '')
        ORDER BY p.created_at DESC
        LIMIT 1
      ) ae_price ON true
      LEFT JOIN LATERAL (
        SELECT CAST(NULLIF(p.buy_price->>'usd', 'NaN') AS DECIMAL) AS current_unit_price_usd
        FROM transactions p
        WHERE p.sale_address = agg.sale_address
          AND p.created_at < agg.snapshot_ts
          AND p.buy_price->>'usd' IS NOT NULL
          AND p.buy_price->>'usd' NOT IN ('NaN', 'null', '')
        ORDER BY p.created_at DESC
        LIMIT 1
      ) usd_price ON true
      WHERE agg.current_holdings > 0
         OR agg.cumulative_volume_bought > 0
         OR agg.total_volume_sold > 0
    `;
  }

  private mapDailyPnlBatch(
    rows: Array<Record<string, any>>,
    windows: DailyPnlWindow[],
  ): Map<number, TokenPnlResult> {
    // Group rows by snapshot_ts_ms
    const rowsByTs = new Map<number, Array<Record<string, any>>>();
    for (const w of windows) {
      rowsByTs.set(w.snapshotTs, []);
    }
    for (const row of rows) {
      // snapshot_ts_ms comes back as a string from pg driver
      const ts = Number(row.snapshot_ts_ms);
      // Find the matching window key — we need to match by rounding since
      // epoch round-trip through float8 and EXTRACT may drift by a few ms
      let matchedKey: number | undefined;
      for (const w of windows) {
        if (Math.abs(ts - w.snapshotTs) <= 1000) {
          matchedKey = w.snapshotTs;
          break;
        }
      }
      if (matchedKey !== undefined) {
        rowsByTs.get(matchedKey)!.push(row);
      }
    }

    const result = new Map<number, TokenPnlResult>();
    for (const [ts, tsRows] of rowsByTs.entries()) {
      result.set(ts, this.mapTokenPnls(tsRows, true));
    }
    return result;
  }

  private mapTokenPnlsBatch(
    rows: Array<Record<string, any>>,
    uniqueHeights: number[],
    fromBlockHeight?: number,
  ): Map<number, TokenPnlResult> {
    const isRangeBased =
      fromBlockHeight !== undefined && fromBlockHeight !== null;

    // Group rows by snapshot_height
    const rowsByHeight = new Map<number, Array<Record<string, any>>>();
    for (const height of uniqueHeights) {
      rowsByHeight.set(height, []);
    }
    for (const row of rows) {
      const height = Number(row.snapshot_height);
      const group = rowsByHeight.get(height);
      if (group) {
        group.push(row);
      }
    }

    // Map each height's rows using the existing single-height mapper
    const result = new Map<number, TokenPnlResult>();
    for (const [height, heightRows] of rowsByHeight.entries()) {
      result.set(height, this.mapTokenPnls(heightRows, isRangeBased));
    }
    return result;
  }

  private buildTokenPnlsQuery(fromBlockHeight?: number): string {
    const hasRange = fromBlockHeight !== undefined && fromBlockHeight !== null;
    const rangeCondition = hasRange ? ' AND tx.block_height >= $3' : '';

    const cumulativeColumns = hasRange
      ? `,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')
                  THEN CAST(tx.volume AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS cumulative_volume_bought,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS cumulative_amount_spent_ae,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS cumulative_amount_spent_usd`
      : '';

    const cumulativeSelectColumns = hasRange
      ? `
        agg.cumulative_volume_bought,
        agg.cumulative_amount_spent_ae,
        agg.cumulative_amount_spent_usd,`
      : '';

    return `
      WITH aggregated_holdings AS (
        SELECT
          tx.sale_address AS sale_address,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')
                  THEN CAST(tx.volume AS DECIMAL)
                ELSE 0
              END
            ) -
            COALESCE(
              SUM(
                CASE
                  WHEN tx.tx_type = 'sell'
                    THEN CAST(tx.volume AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            ),
            0
          ) AS current_holdings,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')${rangeCondition}
                  THEN CAST(tx.volume AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_volume_bought,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')${rangeCondition}
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_amount_spent_ae,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type IN ('buy', 'create_community')${rangeCondition}
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_amount_spent_usd,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type = 'sell'${rangeCondition}
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_amount_received_ae,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type = 'sell'${rangeCondition}
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_amount_received_usd,
          COALESCE(
            SUM(
              CASE
                WHEN tx.tx_type = 'sell'${rangeCondition}
                  THEN CAST(tx.volume AS DECIMAL)
                ELSE 0
              END
            ),
            0
          ) AS total_volume_sold${cumulativeColumns}
        FROM transactions tx
        WHERE tx.address = $1
          AND tx.block_height < $2
        GROUP BY tx.sale_address
      )
      SELECT
        agg.sale_address,
        agg.current_holdings,
        agg.total_volume_bought,
        agg.total_amount_spent_ae,
        agg.total_amount_spent_usd,
        agg.total_amount_received_ae,
        agg.total_amount_received_usd,
        agg.total_volume_sold,${cumulativeSelectColumns}
        ae_price.current_unit_price_ae,
        usd_price.current_unit_price_usd
      FROM aggregated_holdings agg
      LEFT JOIN LATERAL (
        SELECT CAST(NULLIF(p.buy_price->>'ae', 'NaN') AS DECIMAL) AS current_unit_price_ae
        FROM transactions p
        WHERE p.sale_address = agg.sale_address
          AND p.block_height <= $2
          AND p.buy_price->>'ae' IS NOT NULL
          AND p.buy_price->>'ae' NOT IN ('NaN', 'null', '')
        ORDER BY p.block_height DESC, p.created_at DESC
        LIMIT 1
      ) ae_price ON true
      LEFT JOIN LATERAL (
        SELECT CAST(NULLIF(p.buy_price->>'usd', 'NaN') AS DECIMAL) AS current_unit_price_usd
        FROM transactions p
        WHERE p.sale_address = agg.sale_address
          AND p.block_height <= $2
          AND p.buy_price->>'usd' IS NOT NULL
          AND p.buy_price->>'usd' NOT IN ('NaN', 'null', '')
        ORDER BY p.block_height DESC, p.created_at DESC
        LIMIT 1
      ) usd_price ON true
      WHERE agg.current_holdings > 0
         OR agg.total_volume_bought > 0
         OR agg.total_volume_sold > 0
    `;
  }

  private buildQueryParameters(
    address: string,
    blockHeight: number,
    fromBlockHeight?: number,
  ): Array<string | number> {
    return fromBlockHeight !== undefined && fromBlockHeight !== null
      ? [address, blockHeight, fromBlockHeight]
      : [address, blockHeight];
  }

  private mapTokenPnls(
    tokenPnls: Array<Record<string, any>>,
    isRangeBased: boolean,
  ): TokenPnlResult {

    const result: TokenPnlResult['pnls'] = {};
    let totalCostBasisAe = 0;
    let totalCostBasisUsd = 0;
    let totalCurrentValueAe = 0;
    let totalCurrentValueUsd = 0;
    let totalGainAe = 0;
    let totalGainUsd = 0;

    for (const tokenPnl of tokenPnls) {
      const saleAddress = tokenPnl.sale_address;
      const currentHoldings = Number(tokenPnl.current_holdings || 0);
      const totalVolumeSold = Number(tokenPnl.total_volume_sold || 0);
      const totalAmountSpentAe = Number(tokenPnl.total_amount_spent_ae || 0);
      const totalAmountSpentUsd = Number(tokenPnl.total_amount_spent_usd || 0);
      const totalAmountReceivedAe = Number(
        tokenPnl.total_amount_received_ae || 0,
      );
      const totalAmountReceivedUsd = Number(
        tokenPnl.total_amount_received_usd || 0,
      );
      const currentUnitPriceAe = Number(tokenPnl.current_unit_price_ae || 0);
      const currentUnitPriceUsd = Number(tokenPnl.current_unit_price_usd || 0);

      // Current value of all tokens still held at this block height.
      // Used for portfolio chart and cumulative PnL "current value" field.
      const currentValueAe = currentHoldings * currentUnitPriceAe;
      const currentValueUsd = currentHoldings * currentUnitPriceUsd;
      totalCurrentValueAe += currentValueAe;
      totalCurrentValueUsd += currentValueUsd;

      let costBasisAe: number;
      let costBasisUsd: number;
      let gainAe: number;
      let gainUsd: number;

      if (isRangeBased) {
        // --- Range-based (daily) PnL: realized gains only ---
        //
        // "invested" = cost basis of tokens that were actually sold in this
        // period, valued at the all-time average purchase price.
        // "gain"     = sell proceeds - cost basis of sold tokens.
        //
        // We deliberately exclude unrealized gains from tokens still open so
        // that the calendar only turns green/red when a trade is closed.
        const cumulativeVolumeBought = Number(
          tokenPnl.cumulative_volume_bought || 0,
        );
        const cumulativeAmountSpentAe = Number(
          tokenPnl.cumulative_amount_spent_ae || 0,
        );
        const cumulativeAmountSpentUsd = Number(
          tokenPnl.cumulative_amount_spent_usd || 0,
        );

        const cumulativeAvgCostAe =
          cumulativeVolumeBought > 0
            ? cumulativeAmountSpentAe / cumulativeVolumeBought
            : 0;
        const cumulativeAvgCostUsd =
          cumulativeVolumeBought > 0
            ? cumulativeAmountSpentUsd / cumulativeVolumeBought
            : 0;

        costBasisAe = cumulativeAvgCostAe * totalVolumeSold;
        costBasisUsd = cumulativeAvgCostUsd * totalVolumeSold;

        gainAe = totalAmountReceivedAe - costBasisAe;
        gainUsd = totalAmountReceivedUsd - costBasisUsd;
      } else {
        // --- Cumulative PnL ---
        //
        // "invested"     = everything ever spent on this token.
        // "current_value"= market value of tokens still held.
        // "gain"         = proceeds from all sells + current value - total spent.
        // This correctly handles partial exits and fully closed positions.
        costBasisAe = totalAmountSpentAe;
        costBasisUsd = totalAmountSpentUsd;

        gainAe = totalAmountReceivedAe + currentValueAe - totalAmountSpentAe;
        gainUsd = totalAmountReceivedUsd + currentValueUsd - totalAmountSpentUsd;
      }

      totalCostBasisAe += costBasisAe;
      totalCostBasisUsd += costBasisUsd;
      totalGainAe += gainAe;
      totalGainUsd += gainUsd;

      const pnlPercentage = costBasisAe > 0 ? (gainAe / costBasisAe) * 100 : 0;

      result[saleAddress] = {
        current_unit_price: {
          ae: currentUnitPriceAe,
          usd: currentUnitPriceUsd,
        },
        percentage: pnlPercentage,
        invested: {
          ae: costBasisAe,
          usd: costBasisUsd,
        },
        current_value: {
          ae: currentValueAe,
          usd: currentValueUsd,
        },
        gain: {
          ae: gainAe,
          usd: gainUsd,
        },
      };
    }

    return {
      pnls: result,
      totalCostBasisAe,
      totalCostBasisUsd,
      totalCurrentValueAe,
      totalCurrentValueUsd,
      totalGainAe,
      totalGainUsd,
    };
  }
}
