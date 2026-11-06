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
   * Cumulative PnL for one account at many block heights, each matching
   * calculateTokenPnls at that height.
   *
   * @param address - Account address
   * @param blockHeights - Block heights to calculate PNL at
   * @param includeTokenPnls - false leaves `pnls` empty and computes just
   * the totals
   * @returns Map from block height to its TokenPnlResult
   */
  async calculateTokenPnlsBatch(
    address: string,
    blockHeights: number[],
    includeTokenPnls = true,
  ): Promise<Map<number, TokenPnlResult>> {
    const uniqueHeights = [...new Set(blockHeights)];
    if (uniqueHeights.length === 0) {
      return new Map();
    }

    // Joining every height to every account trade is ~3M rows for a 90-day
    // chart of a 33k-token account, so the database returns running totals
    // and prices only where they change, and the heights are walked here.
    const sortedHeights = [...uniqueHeights].sort((a, b) => a - b);
    const minHeight = sortedHeights[0];
    const maxHeight = sortedHeights[sortedHeights.length - 1];
    const [tradeRows, priceRows] = await Promise.all([
      this.transactionRepository.query(this.buildCumulativeTradeTotalsQuery(), [
        address,
        maxHeight,
        minHeight,
      ]),
      this.transactionRepository.query(this.buildPricePointsQuery(), [
        address,
        maxHeight,
        minHeight,
        sortedHeights,
      ]),
    ]);

    return this.mapCumulativeTokenPnlsBatch(
      tradeRows,
      priceRows,
      uniqueHeights,
      sortedHeights,
      includeTokenPnls,
    );
  }

  /**
   * Calculate PNL for each token, for MANY addresses, across multiple shared
   * block heights, in a single SQL query.
   *
   * Built for the leaderboard's event-window path, which previously called
   * `calculateTokenPnlsBatch` once per candidate address (concurrency 8, cap
   * 500) even though every candidate shares the same sample heights. This
   * adds `address` as a grouping dimension to the same aggregation so the
   * whole candidate set resolves in one query.
   *
   * @param addresses - Candidate account addresses
   * @param blockHeights - Array of block heights to calculate PNL at (shared across all addresses)
   * @param fromBlockHeight - Optional: If provided, restrict cost-basis aggregates to this range
   * @returns Map from address to its Map from block height to TokenPnlResult
   */
  async calculateTokenPnlsBatchForAddresses(
    addresses: string[],
    blockHeights: number[],
    fromBlockHeight?: number,
  ): Promise<Map<string, Map<number, TokenPnlResult>>> {
    const uniqueAddresses = [...new Set(addresses)];
    const uniqueHeights = [...new Set(blockHeights)];
    if (uniqueAddresses.length === 0 || uniqueHeights.length === 0) {
      return new Map();
    }

    const rows = await this.transactionRepository.query(
      this.buildBatchTokenPnlsQueryForAddresses(fromBlockHeight),
      this.buildBatchQueryParametersForAddresses(
        uniqueAddresses,
        uniqueHeights,
        fromBlockHeight,
      ),
    );

    return this.mapTokenPnlsBatchForAddresses(
      rows,
      uniqueAddresses,
      uniqueHeights,
      fromBlockHeight,
    );
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
      -- Latest market price per token (from any trader, not just this address).
      -- LATERAL rather than DISTINCT ON + IN: the IN-subquery join blocks the
      -- (sale_address, created_at) index, forcing a seq scan + on-disk sort of
      -- every transaction. CROSS JOIN (not LEFT) keeps DISTINCT ON's behaviour
      -- of dropping tokens with no usable price row.
      token_price AS (
        SELECT t.sale_address, x.unit_price_ae, x.unit_price_usd
        FROM (SELECT sale_address FROM token_agg WHERE current_holdings > 0) t
        CROSS JOIN LATERAL (
          SELECT
            CAST(NULLIF(p.buy_price->>'ae', 'NaN') AS DECIMAL) AS unit_price_ae,
            CAST(NULLIF(p.buy_price->>'usd', 'NaN') AS DECIMAL) AS unit_price_usd
          FROM transactions p
          WHERE p.sale_address = t.sale_address
            AND p.buy_price->>'ae' IS NOT NULL
            AND p.buy_price->>'ae' NOT IN ('NaN', 'null', '')
          ORDER BY p.created_at DESC
          LIMIT 1
        ) x
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

  private mapTradingStats(
    row: Record<string, any> | undefined,
  ): TradingStatsResult {
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

  private buildCumulativeTradeTotalsQuery(): string {
    // $1 address, $2 highest snapshot height, $3 lowest snapshot height.
    return `
      WITH per_block AS (
        SELECT
          tx.sale_address,
          tx.block_height,
          COALESCE(SUM(CASE WHEN tx.tx_type IN ('buy', 'create_community')
            THEN CAST(tx.volume AS DECIMAL) ELSE 0 END), 0) AS bought,
          COALESCE(SUM(CASE WHEN tx.tx_type = 'sell'
            THEN CAST(tx.volume AS DECIMAL) ELSE 0 END), 0) AS sold,
          COALESCE(SUM(CASE WHEN tx.tx_type IN ('buy', 'create_community')
            THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL) ELSE 0 END), 0) AS spent_ae,
          COALESCE(SUM(CASE WHEN tx.tx_type IN ('buy', 'create_community')
            THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL) ELSE 0 END), 0) AS spent_usd,
          COALESCE(SUM(CASE WHEN tx.tx_type = 'sell'
            THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL) ELSE 0 END), 0) AS received_ae,
          COALESCE(SUM(CASE WHEN tx.tx_type = 'sell'
            THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL) ELSE 0 END), 0) AS received_usd
        FROM transactions tx
        WHERE tx.address = $1
          AND tx.block_height < $2
        GROUP BY tx.sale_address, tx.block_height
      ),
      running AS (
        SELECT
          sale_address,
          block_height,
          SUM(bought) OVER w - SUM(sold) OVER w AS current_holdings,
          SUM(bought) OVER w AS total_volume_bought,
          SUM(sold) OVER w AS total_volume_sold,
          SUM(spent_ae) OVER w AS total_amount_spent_ae,
          SUM(spent_usd) OVER w AS total_amount_spent_usd,
          SUM(received_ae) OVER w AS total_amount_received_ae,
          SUM(received_usd) OVER w AS total_amount_received_usd,
          LEAD(block_height) OVER w AS next_block_height
        FROM per_block
        WINDOW w AS (PARTITION BY sale_address ORDER BY block_height)
      )
      SELECT
        sale_address,
        block_height,
        current_holdings,
        total_volume_bought,
        total_volume_sold,
        total_amount_spent_ae,
        total_amount_spent_usd,
        total_amount_received_ae,
        total_amount_received_usd
      FROM running
      -- Below the lowest height only each token's last row is needed.
      WHERE next_block_height IS NULL OR next_block_height >= $3
      ORDER BY sale_address, block_height
    `;
  }

  private buildPricePointsQuery(): string {
    // $1 address, $2/$3 highest/lowest snapshot height, $4 heights ascending.
    // Prices are looked up only where a trade may have moved them; the walk
    // carries them forward in between.
    return `
      WITH held_tokens AS (
        SELECT sale_address, MIN(block_height) AS first_block
        FROM transactions
        WHERE address = $1 AND block_height < $2
        GROUP BY sale_address
      ),
      probes AS (
        -- A token first traded above the lowest height gets its first
        -- lookup from that trade's probe below.
        SELECT sale_address, $3::int AS snapshot_height
        FROM held_tokens
        WHERE first_block <= $3
        UNION
        SELECT
          p.sale_address,
          -- The first snapshot height >= the trade's block.
          ($4::int[])[width_bucket(p.block_height - 1, $4::int[]) + 1]
        FROM held_tokens h
        JOIN transactions p ON p.sale_address = h.sale_address
        WHERE p.block_height > $3
          AND p.block_height >= h.first_block
          AND p.block_height <= $2
      )
      SELECT
        pr.sale_address,
        pr.snapshot_height AS block_height,
        ae_price.price_ae,
        usd_price.price_usd
      FROM probes pr
      -- The lookups calculateTokenPnls runs: tied micro-block trades come
      -- back in index order, which no sort can reproduce.
      LEFT JOIN LATERAL (
        SELECT CAST(NULLIF(p.buy_price->>'ae', 'NaN') AS DECIMAL) AS price_ae
        FROM transactions p
        WHERE p.sale_address = pr.sale_address
          AND p.block_height <= pr.snapshot_height
          AND p.buy_price->>'ae' IS NOT NULL
          AND p.buy_price->>'ae' NOT IN ('NaN', 'null', '')
        ORDER BY p.block_height DESC, p.created_at DESC
        LIMIT 1
      ) ae_price ON true
      LEFT JOIN LATERAL (
        SELECT CAST(NULLIF(p.buy_price->>'usd', 'NaN') AS DECIMAL) AS price_usd
        FROM transactions p
        WHERE p.sale_address = pr.sale_address
          AND p.block_height <= pr.snapshot_height
          AND p.buy_price->>'usd' IS NOT NULL
          AND p.buy_price->>'usd' NOT IN ('NaN', 'null', '')
        ORDER BY p.block_height DESC, p.created_at DESC
        LIMIT 1
      ) usd_price ON true
      ORDER BY pr.sale_address, pr.snapshot_height
    `;
  }

  private mapCumulativeTokenPnlsBatch(
    tradeRows: Array<Record<string, any>>,
    priceRows: Array<Record<string, any>>,
    uniqueHeights: number[],
    sortedHeights: number[],
    includeTokenPnls: boolean,
  ): Map<number, TokenPnlResult> {
    // Both queries return rows ordered by sale_address, then height.
    const groupBySale = (rows: Array<Record<string, any>>) => {
      const groups = new Map<string, Array<Record<string, any>>>();
      for (const row of rows) {
        const list = groups.get(row.sale_address);
        if (list) {
          list.push(row);
        } else {
          groups.set(row.sale_address, [row]);
        }
      }
      return groups;
    };
    const tradesBySale = groupBySale(tradeRows);
    const pricesBySale = groupBySale(priceRows);

    const results = new Map<number, TokenPnlResult>();
    for (const height of sortedHeights) {
      results.set(height, {
        pnls: {},
        totalCostBasisAe: 0,
        totalCostBasisUsd: 0,
        totalCurrentValueAe: 0,
        totalCurrentValueUsd: 0,
        totalGainAe: 0,
        totalGainUsd: 0,
      });
    }

    for (const [saleAddress, trades] of tradesBySale.entries()) {
      const prices = pricesBySale.get(saleAddress) ?? [];
      let tradeIndex = -1;
      let priceIndex = 0;
      let priceAe: string | null = null;
      let priceUsd: string | null = null;
      // Only changes when a trade or price row is passed, so it is computed
      // then and reused for the heights in between.
      let tokenPnl: TokenPnlResult | undefined;

      for (const height of sortedHeights) {
        let changed = false;
        // Trades count when block_height < height.
        while (
          tradeIndex + 1 < trades.length &&
          Number(trades[tradeIndex + 1].block_height) < height
        ) {
          tradeIndex++;
          changed = true;
        }
        // A price row is the lookup at its snapshot height.
        while (
          priceIndex < prices.length &&
          Number(prices[priceIndex].block_height) <= height
        ) {
          priceAe = prices[priceIndex].price_ae;
          priceUsd = prices[priceIndex].price_usd;
          priceIndex++;
          changed = true;
        }
        if (tradeIndex < 0) {
          continue;
        }

        if (changed) {
          const totals = trades[tradeIndex];
          tokenPnl =
            Number(totals.current_holdings) > 0 ||
            Number(totals.total_volume_bought) > 0 ||
            Number(totals.total_volume_sold) > 0
              ? this.mapTokenPnls(
                  [
                    {
                      ...totals,
                      current_unit_price_ae: priceAe,
                      current_unit_price_usd: priceUsd,
                    },
                  ],
                  false,
                )
              : undefined;
        }
        if (!tokenPnl) {
          continue;
        }

        const result = results.get(height)!;
        result.totalCostBasisAe += tokenPnl.totalCostBasisAe;
        result.totalCostBasisUsd += tokenPnl.totalCostBasisUsd;
        result.totalCurrentValueAe += tokenPnl.totalCurrentValueAe;
        result.totalCurrentValueUsd += tokenPnl.totalCurrentValueUsd;
        result.totalGainAe += tokenPnl.totalGainAe;
        result.totalGainUsd += tokenPnl.totalGainUsd;
        if (includeTokenPnls) {
          // Shared by every height until the token changes; not to be mutated.
          result.pnls[saleAddress] = tokenPnl.pnls[saleAddress];
        }
      }
    }

    return new Map(
      uniqueHeights.map((height) => [height, results.get(height)!]),
    );
  }

  // buildTokenPnlsQuery's aggregation, also grouped by snapshot height and
  // address so all candidates resolve in one query. Keep the aggregation
  // CASE expressions identical to it.
  private buildBatchTokenPnlsQueryForAddresses(
    fromBlockHeight?: number,
  ): string {
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
      WITH heights AS (
        SELECT unnest($2::int[]) AS snapshot_height
      ),
      -- Scan every candidate's transactions once. MATERIALIZED keeps
      -- PostgreSQL 12+ from inlining this and rescanning it per height.
      addr_txs AS MATERIALIZED (
        SELECT address, sale_address, block_height, tx_type, volume, amount
        FROM transactions
        WHERE address = ANY($1::text[])
      ),
      aggregated_holdings AS (
        SELECT
          h.snapshot_height,
          tx.address AS address,
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
        JOIN addr_txs tx ON tx.block_height < h.snapshot_height
        GROUP BY h.snapshot_height, tx.address, tx.sale_address
      )
      SELECT
        agg.snapshot_height,
        agg.address,
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

  private buildBatchQueryParametersForAddresses(
    addresses: string[],
    blockHeights: number[],
    fromBlockHeight?: number,
  ): Array<string[] | number[] | number> {
    return fromBlockHeight !== undefined && fromBlockHeight !== null
      ? [addresses, blockHeights, fromBlockHeight]
      : [addresses, blockHeights];
  }

  private mapTokenPnlsBatchForAddresses(
    rows: Array<Record<string, any>>,
    addresses: string[],
    heights: number[],
    fromBlockHeight?: number,
  ): Map<string, Map<number, TokenPnlResult>> {
    const isRangeBased =
      fromBlockHeight !== undefined && fromBlockHeight !== null;

    const rowsByAddressHeight = new Map<
      string,
      Map<number, Array<Record<string, any>>>
    >();
    for (const address of addresses) {
      const byHeight = new Map<number, Array<Record<string, any>>>();
      for (const height of heights) {
        byHeight.set(height, []);
      }
      rowsByAddressHeight.set(address, byHeight);
    }
    for (const row of rows) {
      const byHeight = rowsByAddressHeight.get(row.address);
      const group = byHeight?.get(Number(row.snapshot_height));
      if (group) {
        group.push(row);
      }
    }

    const result = new Map<string, Map<number, TokenPnlResult>>();
    for (const [address, byHeight] of rowsByAddressHeight.entries()) {
      const heightMap = new Map<number, TokenPnlResult>();
      for (const [height, heightRows] of byHeight.entries()) {
        heightMap.set(height, this.mapTokenPnls(heightRows, isRangeBased));
      }
      result.set(address, heightMap);
    }
    return result;
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
        gainUsd =
          totalAmountReceivedUsd + currentValueUsd - totalAmountSpentUsd;
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
