import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
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
    @InjectDataSource() private readonly dataSource: DataSource,
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
    const tokenPnlsQuery = this.transactionRepository
      .createQueryBuilder('tx')
      .select('tx.sale_address', 'sale_address')
      .addSelect(
        // IMPORTANT: current_holdings must always be cumulative (all transactions up to blockHeight)
        // Holdings represent actual token balance at blockHeight, not net change within range
        // Only cost basis fields (total_volume_bought, total_amount_spent_*) should be filtered by fromBlockHeight
        `COALESCE(
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
        )`,
        'current_holdings',
      )
      .addSelect(
        fromBlockHeight !== undefined && fromBlockHeight !== null
          ? `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type IN ('buy', 'create_community') 
                    AND tx.block_height >= :fromBlockHeight
                  THEN CAST(tx.volume AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`
          : `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type IN ('buy', 'create_community') 
                  THEN CAST(tx.volume AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`,
        'total_volume_bought',
      )
      .addSelect(
        fromBlockHeight !== undefined && fromBlockHeight !== null
          ? `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type IN ('buy', 'create_community') 
                    AND tx.block_height >= :fromBlockHeight
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`
          : `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type IN ('buy', 'create_community') 
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`,
        'total_amount_spent_ae',
      )
      .addSelect(
        fromBlockHeight !== undefined && fromBlockHeight !== null
          ? `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type IN ('buy', 'create_community') 
                    AND tx.block_height >= :fromBlockHeight
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`
          : `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type IN ('buy', 'create_community') 
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`,
        'total_amount_spent_usd',
      )
      .addSelect(
        // Track sale proceeds for range-based PNL
        // This is needed to calculate accurate PNL when tokens are bought and sold within the range
        fromBlockHeight !== undefined && fromBlockHeight !== null
          ? `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type = 'sell' 
                    AND tx.block_height >= :fromBlockHeight
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`
          : `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type = 'sell' 
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`,
        'total_amount_received_ae',
      )
      .addSelect(
        // Track sale proceeds in USD for range-based PNL
        fromBlockHeight !== undefined && fromBlockHeight !== null
          ? `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type = 'sell' 
                    AND tx.block_height >= :fromBlockHeight
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`
          : `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type = 'sell' 
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`,
        'total_amount_received_usd',
      )
      .addSelect(
        // Track volume sold for range-based PNL
        fromBlockHeight !== undefined && fromBlockHeight !== null
          ? `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type = 'sell' 
                    AND tx.block_height >= :fromBlockHeight
                  THEN CAST(tx.volume AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`
          : `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type = 'sell' 
                  THEN CAST(tx.volume AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`,
        'total_volume_sold',
      )
      .addSelect(
        `(
          SELECT CAST(NULLIF(tx2.buy_price->>'ae', 'NaN') AS DECIMAL)
          FROM transactions tx2
          WHERE tx2.sale_address = tx.sale_address
            AND tx2.block_height <= :blockHeight
            AND tx2.buy_price->>'ae' IS NOT NULL
            AND tx2.buy_price->>'ae' != 'NaN'
            AND tx2.buy_price->>'ae' != 'null'
            AND tx2.buy_price->>'ae' != ''
          ORDER BY tx2.block_height DESC, tx2.created_at DESC
          LIMIT 1
        )`,
        'current_unit_price_ae',
      )
      .addSelect(
        `(
          SELECT CAST(NULLIF(tx2.buy_price->>'usd', 'NaN') AS DECIMAL)
          FROM transactions tx2
          WHERE tx2.sale_address = tx.sale_address
            AND tx2.block_height <= :blockHeight
            AND tx2.buy_price->>'usd' IS NOT NULL
            AND tx2.buy_price->>'usd' != 'NaN'
            AND tx2.buy_price->>'usd' != 'null'
            AND tx2.buy_price->>'usd' != ''
          ORDER BY tx2.block_height DESC, tx2.created_at DESC
          LIMIT 1
        )`,
        'current_unit_price_usd',
      )
      .where('tx.address = :address', { address })
      .andWhere('tx.block_height < :blockHeight', { blockHeight });
    
    // If fromBlockHeight is provided, we need to calculate range-based PNL:
    // - Calculate holdings cumulatively (all transactions up to blockHeight) - represents actual token balance
    // - Calculate cost basis only for tokens bought in the range (>= fromBlockHeight)
    // - This ensures holdings reflect actual balance while PNL reflects range performance
    
    tokenPnlsQuery
      .groupBy('tx.sale_address')
      .having(
        // HAVING clause should check for actual holdings (cumulative) at blockHeight
        // This ensures tokens with holdings are included even if bought before the range
        // For range-based PNL, cost basis will be calculated only from range transactions,
        // but holdings must reflect actual balance at blockHeight
        `COALESCE(
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
        ) > 0`,
      )
      .setParameter('blockHeight', blockHeight);
    
    // Set fromBlockHeight parameter if provided (needed for range-based PNL calculations)
    if (fromBlockHeight !== undefined && fromBlockHeight !== null) {
      tokenPnlsQuery.setParameter('fromBlockHeight', fromBlockHeight);
    }
    
    const tokenPnls = await tokenPnlsQuery.getRawMany();

    const result: Record<
      string,
      {
        current_unit_price: { ae: number; usd: number };
        percentage: number;
        invested: { ae: number; usd: number };
        current_value: { ae: number; usd: number };
        gain: { ae: number; usd: number };
      }
    > = {};
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
      const totalAmountReceivedAe = Number(tokenPnl.total_amount_received_ae || 0);
      const totalAmountReceivedUsd = Number(tokenPnl.total_amount_received_usd || 0);
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
      const costBasisAe = fromBlockHeight !== undefined && fromBlockHeight !== null
        ? totalAmountSpentAe // Only purchases in range
        : currentHoldings * averageCostPerTokenAe; // All holdings for cumulative PNL
      const costBasisUsd = fromBlockHeight !== undefined && fromBlockHeight !== null
        ? totalAmountSpentUsd // Only purchases in range
        : currentHoldings * averageCostPerTokenUsd; // All holdings for cumulative PNL
      
      totalCostBasisAe += costBasisAe;
      totalCostBasisUsd += costBasisUsd;

      // Calculate current value for range-based PNL
      // If fromBlockHeight is provided, current value should only include tokens bought in range that are still held
      // Remaining tokens = tokens bought in range - tokens sold in range
      // If fromBlockHeight is not provided, use all currentHoldings (cumulative PNL)
      let holdingsForCurrentValue: number;
      if (fromBlockHeight !== undefined && fromBlockHeight !== null) {
        // For range-based PNL: calculate remaining tokens bought in range
        // Remaining = max(0, totalVolumeBought - totalVolumeSold)
        // But we also need to account for tokens bought before range that might still be held
        // So we use: min(currentHoldings, max(0, totalVolumeBought - totalVolumeSold))
        const remainingFromRange = Math.max(0, totalVolumeBought - totalVolumeSold);
        holdingsForCurrentValue = Math.min(currentHoldings, remainingFromRange);
      } else {
        // All holdings for cumulative PNL
        holdingsForCurrentValue = currentHoldings;
      }
      
      const currentValueAe = holdingsForCurrentValue * currentUnitPriceAe;
      const currentValueUsd = holdingsForCurrentValue * currentUnitPriceUsd;
      totalCurrentValueAe += currentValueAe;
      totalCurrentValueUsd += currentValueUsd;

      // Calculate gain for range-based PNL
      // Gain = (sale proceeds + current value of remaining tokens) - cost basis
      // This accounts for both tokens sold and tokens still held
      let gainAe: number;
      let gainUsd: number;
      if (fromBlockHeight !== undefined && fromBlockHeight !== null) {
        // Range-based PNL: include sale proceeds
        // Gain = (proceeds from sales + current value of remaining tokens) - cost of purchases
        gainAe = (totalAmountReceivedAe + currentValueAe) - costBasisAe;
        gainUsd = (totalAmountReceivedUsd + currentValueUsd) - costBasisUsd;
      } else {
        // Cumulative PNL: current value - cost basis
        gainAe = currentValueAe - costBasisAe;
        gainUsd = currentValueUsd - costBasisUsd;
      }
      
      totalGainAe += gainAe;
      totalGainUsd += gainUsd;

      // Calculate PNL percentage
      const pnlPercentage =
        costBasisAe > 0 ? (gainAe / costBasisAe) * 100 : 0;

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

