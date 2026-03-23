import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transaction } from '@/transactions/entities/transaction.entity';

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
    return this.mapTokenPnls(tokenPnls, fromBlockHeight);
  }

  private buildTokenPnlsQuery(fromBlockHeight?: number): string {
    const hasRange = fromBlockHeight !== undefined && fromBlockHeight !== null;
    const rangeCondition = hasRange ? ' AND tx.block_height >= $3' : '';

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
          ) AS total_volume_sold
        FROM transactions tx
        WHERE tx.address = $1
          AND tx.block_height < $2
        GROUP BY tx.sale_address
      ),
      latest_price_ae AS (
        SELECT DISTINCT ON (tx.sale_address)
          tx.sale_address,
          CAST(NULLIF(tx.buy_price->>'ae', 'NaN') AS DECIMAL) AS current_unit_price_ae
        FROM transactions tx
        INNER JOIN aggregated_holdings agg
          ON agg.sale_address = tx.sale_address
        WHERE tx.block_height <= $2
          AND tx.buy_price->>'ae' IS NOT NULL
          AND tx.buy_price->>'ae' != 'NaN'
          AND tx.buy_price->>'ae' != 'null'
          AND tx.buy_price->>'ae' != ''
        ORDER BY tx.sale_address, tx.block_height DESC, tx.created_at DESC
      ),
      latest_price_usd AS (
        SELECT DISTINCT ON (tx.sale_address)
          tx.sale_address,
          CAST(NULLIF(tx.buy_price->>'usd', 'NaN') AS DECIMAL) AS current_unit_price_usd
        FROM transactions tx
        INNER JOIN aggregated_holdings agg
          ON agg.sale_address = tx.sale_address
        WHERE tx.block_height <= $2
          AND tx.buy_price->>'usd' IS NOT NULL
          AND tx.buy_price->>'usd' != 'NaN'
          AND tx.buy_price->>'usd' != 'null'
          AND tx.buy_price->>'usd' != ''
        ORDER BY tx.sale_address, tx.block_height DESC, tx.created_at DESC
      )
      SELECT
        agg.sale_address,
        agg.current_holdings,
        agg.total_volume_bought,
        agg.total_amount_spent_ae,
        agg.total_amount_spent_usd,
        agg.total_amount_received_ae,
        agg.total_amount_received_usd,
        agg.total_volume_sold,
        latest_price_ae.current_unit_price_ae,
        latest_price_usd.current_unit_price_usd
      FROM aggregated_holdings agg
      LEFT JOIN latest_price_ae
        ON latest_price_ae.sale_address = agg.sale_address
      LEFT JOIN latest_price_usd
        ON latest_price_usd.sale_address = agg.sale_address
      WHERE agg.current_holdings > 0
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
    fromBlockHeight?: number,
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
      const totalVolumeBought = Number(tokenPnl.total_volume_bought || 0);
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

      // Calculate average cost per token (only for tokens bought in range if fromBlockHeight is provided)
      const averageCostPerTokenAe =
        totalVolumeBought > 0 ? totalAmountSpentAe / totalVolumeBought : 0;
      const averageCostPerTokenUsd =
        totalVolumeBought > 0 ? totalAmountSpentUsd / totalVolumeBought : 0;

      // Calculate cost basis for range-based PNL
      // If fromBlockHeight is provided, cost basis should only include tokens bought in the range
      // Cost basis = total amount spent on purchases in range
      // If fromBlockHeight is not provided, use all currentHoldings (cumulative PNL)
      const costBasisAe =
        fromBlockHeight !== undefined && fromBlockHeight !== null
          ? totalAmountSpentAe // Only purchases in range
          : currentHoldings * averageCostPerTokenAe; // All holdings for cumulative PNL
      const costBasisUsd =
        fromBlockHeight !== undefined && fromBlockHeight !== null
          ? totalAmountSpentUsd // Only purchases in range
          : currentHoldings * averageCostPerTokenUsd; // All holdings for cumulative PNL

      totalCostBasisAe += costBasisAe;
      totalCostBasisUsd += costBasisUsd;

      // Calculate current value - ALWAYS use cumulative holdings
      // Current value represents the actual value of tokens owned at blockHeight, regardless of when they were bought
      // The range filter (fromBlockHeight) should only affect cost basis and sale proceeds, not current value
      // This ensures accurate portfolio value even when tokens were bought before range and sold within range
      const holdingsForCurrentValue = currentHoldings; // Always use cumulative holdings for current value

      const currentValueAe = holdingsForCurrentValue * currentUnitPriceAe;
      const currentValueUsd = holdingsForCurrentValue * currentUnitPriceUsd;
      totalCurrentValueAe += currentValueAe;
      totalCurrentValueUsd += currentValueUsd;

      // Calculate gain for range-based PNL
      // For range-based PNL: Gain = (sale proceeds + current value of tokens bought in range) - cost basis
      // This accounts for both tokens sold and tokens still held from range purchases
      // Note: Current value uses all holdings (for accurate portfolio value), but gain calculation
      // only attributes value to tokens bought in range to avoid including tokens bought before range
      let gainAe: number;
      let gainUsd: number;
      if (fromBlockHeight !== undefined && fromBlockHeight !== null) {
        // Range-based PNL: calculate value of tokens bought in range that are still held
        // Remaining tokens from range = max(0, totalVolumeBought - totalVolumeSold)
        // But cap at currentHoldings to handle edge cases
        const remainingFromRange = Math.max(
          0,
          Math.min(currentHoldings, totalVolumeBought - totalVolumeSold),
        );
        const currentValueFromRangeAe = remainingFromRange * currentUnitPriceAe;
        const currentValueFromRangeUsd =
          remainingFromRange * currentUnitPriceUsd;

        // Gain = (proceeds from sales + current value of tokens bought in range) - cost of purchases
        gainAe = totalAmountReceivedAe + currentValueFromRangeAe - costBasisAe;
        gainUsd =
          totalAmountReceivedUsd + currentValueFromRangeUsd - costBasisUsd;
      } else {
        // Cumulative PNL: current value - cost basis
        gainAe = currentValueAe - costBasisAe;
        gainUsd = currentValueUsd - costBasisUsd;
      }

      totalGainAe += gainAe;
      totalGainUsd += gainUsd;

      // Calculate PNL percentage
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
