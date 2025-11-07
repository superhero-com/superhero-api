import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import moment, { Moment } from 'moment';
import { DataSource, Repository } from 'typeorm';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { Token } from '@/tokens/entities/token.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { CoinGeckoService } from '@/ae/coin-gecko.service';
import { AETERNITY_COIN_ID } from '@/configs';
import { toAe } from '@aeternity/aepp-sdk';
import { timestampToAeHeight } from '@/utils/getBlochHeight';
import { BclPnlService } from './bcl-pnl.service';

export interface PortfolioHistorySnapshot {
  timestamp: Moment | Date;
  block_height: number;
  tokens_value_ae: number;
  tokens_value_usd: number;
  total_value_ae: number;
  total_value_usd: number;
  ae_balance: number;
  usd_balance: number;
  ae_price: number;
  version: number;
  total_pnl?: {
    percentage: number;
    invested: {
      ae: number;
      usd: number;
    },
    current_value: {
      ae: number;
      usd: number;
    };
    gain: {
      ae: number;
      usd: number;
    };
  };
  tokens_pnl?: Record<string, {
    current_unit_price: {
      ae: number;
      usd: number;
    };
    percentage: number;
    invested: {
      ae: number;
      usd: number;
    },
    current_value: {
      ae: number;
      usd: number;
    };
    gain: {
      ae: number;
      usd: number;
    };
  }>;
}

export interface GetPortfolioHistoryOptions {
  startDate?: Moment;
  endDate?: Moment;
  interval?: number; // seconds, default 86400 (daily)
  convertTo?:
  | 'ae'
  | 'usd'
  | 'eur'
  | 'aud'
  | 'brl'
  | 'cad'
  | 'chf'
  | 'gbp'
  | 'xau';
  includePnl?: boolean; // Whether to include PNL data
}

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(
    @InjectRepository(TokenHolder)
    private readonly tokenHolderRepository: Repository<TokenHolder>,
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly aeSdkService: AeSdkService,
    private readonly coinGeckoService: CoinGeckoService,
    private readonly bclPnlService: BclPnlService,
  ) { }


  async getPortfolioHistory(
    address: string,
    options: GetPortfolioHistoryOptions = {},
  ): Promise<PortfolioHistorySnapshot[]> {
    const {
      startDate,
      endDate,
      interval = 86400, // Default daily (24 hours)
      convertTo = 'ae',
      includePnl = false,
    } = options;

    // Calculate date range
    const end = moment(endDate || moment()).add(1, 'day');
    const start = startDate || moment().subtract(90, 'days'); // Default to last 90 days

    const defaultInterval = 86400; // Default daily (24 hours)
    const safeInterval = interval > 0 ? interval : defaultInterval;

    // Generate timestamp intervals
    const timestamps: Moment[] = [];
    const current = moment(start);
    const maxIterations = 100000; // Safety limit to prevent infinite loops
    let iterations = 0;
    const endTimestamp = end.valueOf();

    while (current.valueOf() <= endTimestamp) {
      if (iterations >= maxIterations) {
        this.logger.error(
          `Timestamp generation exceeded max iterations (${maxIterations}), stopping to prevent infinite loop`,
        );
        break;
      }
      timestamps.push(moment(current));
      const previousTimestamp = current.valueOf();
      current.add(safeInterval, 'seconds');
      iterations++;

      // Additional safety check: if current didn't advance, break
      if (current.valueOf() <= previousTimestamp) {
        this.logger.error(
          `Timestamp generation stalled, current timestamp did not advance (${current.valueOf()} <= ${previousTimestamp}). Stopping to prevent infinite loop.`,
        );
        break;
      }
    }

    let previousHeight: number | undefined = undefined;
    // CoinGecko supports: 1, 7, 14, 30, 90, 180, 365, max
    // Request 365 days to ensure we get historical data (it will include our date range if it's within the last year)
    const days = 365;
    // Always use 'daily' interval from CoinGecko - hourly data is not reliably available
    // We'll use the closest daily price for any timestamp (including hourly requests)
    const priceInterval: 'daily' | 'hourly' = 'daily';
    const aePriceHistory = (await this.coinGeckoService.fetchHistoricalPrice(
      AETERNITY_COIN_ID,
      'usd', // force to usd
      days,
      priceInterval,
    )).sort((a, b) => b[0] - a[0]);
    const currentAePrice = await this.coinGeckoService.getPriceData(new BigNumber(1));

    const data = await Promise.all(
      timestamps.map(async (timestamp) => {
        // the aePriceHistory is an array of [timestamp_ms, price] pairs
        // we need to find the closest price to the timestamp
        const closestPrice = aePriceHistory.find(([priceTimeMs]) => {
          return priceTimeMs <= timestamp.valueOf();
        });
        const price = closestPrice ? closestPrice[1] : currentAePrice?.usd || 0;
        const blockHeight = await timestampToAeHeight(
          timestamp.valueOf(),
          previousHeight,
          this.dataSource,
        );
        previousHeight = blockHeight;
        
        // Prepare promises for parallel execution
        const promises = [
          this.transactionRepository
            .createQueryBuilder('tx')
            .select(
              `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type IN ('buy', 'create_community') 
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                  ELSE 0
                END
              ) - 
              SUM(
                CASE 
                  WHEN tx.tx_type = 'sell' 
                  THEN CAST(NULLIF(tx.amount->>'ae', 'NaN') AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`,
              'net_ae',
            )
            .addSelect(
              `COALESCE(
              SUM(
                CASE 
                  WHEN tx.tx_type IN ('buy', 'create_community') 
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                  ELSE 0
                END
              ) - 
              SUM(
                CASE 
                  WHEN tx.tx_type = 'sell' 
                  THEN CAST(NULLIF(tx.amount->>'usd', 'NaN') AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            )`,
              'net_usd',
            )
            .where('tx.address = :address', { address })
            .andWhere('tx.block_height < :blockHeight', { blockHeight })
            .getRawOne(),
          this.aeSdkService.sdk.getBalance(
            address as any,
            {
              height: blockHeight,
            } as any,
          ),
        ];

        // Add PNL calculation promise only if requested
        if (includePnl) {
          promises.push(
            this.bclPnlService.calculateTokenPnls(address, blockHeight),
          );
        }

        const results = await Promise.all(promises);
        const totalBclTokensValue = results[0];
        const aeBalance = results[1];
        const tokensPnl = includePnl ? results[2] : null;

        const balance = Number(toAe(aeBalance));

        const tokensValue = Number(totalBclTokensValue.net_ae);
        const tokensValueUsd = Number(totalBclTokensValue.net_usd || 0);

        const result: PortfolioHistorySnapshot = {
          timestamp,
          block_height: blockHeight,
          tokens_value_ae: tokensValue,
          tokens_value_usd: tokensValueUsd,
          total_value_ae: balance + tokensValue,
          total_value_usd: (balance + tokensValue) * price,
          ae_balance: balance,
          usd_balance: balance * price,
          ae_price: price,
          version: 1,
        };

        // Include PNL data only if requested
        if (includePnl && tokensPnl) {
          // Calculate total PNL percentage
          const totalPnlPercentage =
            tokensPnl.totalCostBasisAe > 0
              ? (tokensPnl.totalGainAe / tokensPnl.totalCostBasisAe) * 100
              : 0;

          result.total_pnl = {
            percentage: totalPnlPercentage,
            invested: {
              ae: tokensPnl.totalCostBasisAe,
              usd: tokensPnl.totalCostBasisUsd,
            },
            current_value: {
              ae: tokensPnl.totalCurrentValueAe,
              usd: tokensPnl.totalCurrentValueUsd,
            },
            gain: {
              ae: tokensPnl.totalGainAe,
              usd: tokensPnl.totalGainUsd,
            },
          };
          result.tokens_pnl = tokensPnl.pnls;
        }

        return result;
      }),
    );

    return data;
  }
}
