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
        `COALESCE(
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
        `COALESCE(
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
        `COALESCE(
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
        fromBlockHeight !== undefined && fromBlockHeight !== null
          ? `(
              SELECT CAST(NULLIF(tx2.buy_price->>'ae', 'NaN') AS DECIMAL)
              FROM transactions tx2
              WHERE tx2.sale_address = tx.sale_address
                AND tx2.block_height <= :blockHeight
                AND tx2.block_height >= :fromBlockHeight
                AND tx2.buy_price->>'ae' IS NOT NULL
                AND tx2.buy_price->>'ae' != 'NaN'
                AND tx2.buy_price->>'ae' != 'null'
                AND tx2.buy_price->>'ae' != ''
              ORDER BY tx2.block_height DESC, tx2.created_at DESC
              LIMIT 1
            )`
          : `(
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
        fromBlockHeight !== undefined && fromBlockHeight !== null
          ? `(
              SELECT CAST(NULLIF(tx2.buy_price->>'usd', 'NaN') AS DECIMAL)
              FROM transactions tx2
              WHERE tx2.sale_address = tx.sale_address
                AND tx2.block_height <= :blockHeight
                AND tx2.block_height >= :fromBlockHeight
                AND tx2.buy_price->>'usd' IS NOT NULL
                AND tx2.buy_price->>'usd' != 'NaN'
                AND tx2.buy_price->>'usd' != 'null'
                AND tx2.buy_price->>'usd' != ''
              ORDER BY tx2.block_height DESC, tx2.created_at DESC
              LIMIT 1
            )`
          : `(
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
    
    // If fromBlockHeight is provided, filter transactions to only include those from that block height onwards
    if (fromBlockHeight !== undefined && fromBlockHeight !== null) {
      tokenPnlsQuery.andWhere('tx.block_height >= :fromBlockHeight', { fromBlockHeight });
    }
    
    const tokenPnls = await tokenPnlsQuery
      .groupBy('tx.sale_address')
      .having(
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
      const totalAmountSpentAe = Number(tokenPnl.total_amount_spent_ae || 0);
      const totalAmountSpentUsd = Number(tokenPnl.total_amount_spent_usd || 0);
      const currentUnitPriceAe = Number(tokenPnl.current_unit_price_ae || 0);
      const currentUnitPriceUsd = Number(tokenPnl.current_unit_price_usd || 0);

      // Calculate average cost per token
      const averageCostPerTokenAe =
        totalVolumeBought > 0 ? totalAmountSpentAe / totalVolumeBought : 0;
      const averageCostPerTokenUsd =
        totalVolumeBought > 0 ? totalAmountSpentUsd / totalVolumeBought : 0;

      // Calculate cost basis for current holdings (based on average cost)
      const costBasisAe = currentHoldings * averageCostPerTokenAe;
      const costBasisUsd = currentHoldings * averageCostPerTokenUsd;
      totalCostBasisAe += costBasisAe;
      totalCostBasisUsd += costBasisUsd;

      // Calculate current value (current holdings * current unit price)
      const currentValueAe = currentHoldings * currentUnitPriceAe;
      const currentValueUsd = currentHoldings * currentUnitPriceUsd;
      totalCurrentValueAe += currentValueAe;
      totalCurrentValueUsd += currentValueUsd;

      // Calculate gain (current value - invested)
      const gainAe = currentValueAe - costBasisAe;
      const gainUsd = currentValueUsd - costBasisUsd;
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

