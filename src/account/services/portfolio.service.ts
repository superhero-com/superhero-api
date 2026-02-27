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
    };
    current_value: {
      ae: number;
      usd: number;
    };
    gain: {
      ae: number;
      usd: number;
    };
    range?: {
      from: Moment | Date | null;
      to: Moment | Date;
    };
  };
  tokens_pnl?: Record<
    string,
    {
      current_unit_price: {
        ae: number;
        usd: number;
      };
      percentage: number;
      invested: {
        ae: number;
        usd: number;
      };
      current_value: {
        ae: number;
        usd: number;
      };
      gain: {
        ae: number;
        usd: number;
      };
    }
  >;
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
  useRangeBasedPnl?: boolean; // If true, calculate PNL for range between timestamps; if false, use all previous transactions
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
  ) {}

  async getPortfolioHistory(
    address: string,
    options: GetPortfolioHistoryOptions = {},
  ): Promise<PortfolioHistorySnapshot[]> {
    const {
      startDate,
      endDate,
      interval = 86400, // Default daily (24 hours)
      includePnl = false,
      useRangeBasedPnl = false,
    } = options;

    // Calculate date range
    // Don't add extra day if endDate is explicitly provided - use it as-is
    // Only add 1 day if no endDate is provided (for default 90-day range)
    const now = moment();
    const requestedEnd = endDate || now;
    const end = endDate
      ? moment(requestedEnd) // Use exact end date if provided
      : moment(requestedEnd).add(1, 'day'); // Add 1 day only for default range
    const start = startDate || moment().subtract(90, 'days'); // Default to last 90 days

    // Cap end date to current time to avoid generating future timestamps
    const cappedEnd = moment.min(end, now);

    const defaultInterval = 86400; // Default daily (24 hours)
    const safeInterval = interval > 0 ? interval : defaultInterval;

    // Generate timestamp intervals
    const timestamps: Moment[] = [];
    const current = moment(start);
    const maxIterations = 100000; // Safety limit to prevent infinite loops
    let iterations = 0;
    const endTimestamp = cappedEnd.valueOf();

    while (current.valueOf() <= endTimestamp) {
      if (iterations >= maxIterations) {
        this.logger.error(
          `Timestamp generation exceeded max iterations (${maxIterations}), stopping to prevent infinite loop`,
        );
        break;
      }

      // Don't generate timestamps in the future
      if (current.valueOf() > now.valueOf()) {
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
    const aePriceHistory = (
      await this.coinGeckoService.fetchHistoricalPrice(
        AETERNITY_COIN_ID,
        'usd', // force to usd
        days,
        priceInterval,
      )
    ).sort((a, b) => b[0] - a[0]);
    const currentAePrice = await this.coinGeckoService.getPriceData(
      new BigNumber(1),
    );

    // First, calculate all block heights sequentially (since previousHeight is used as a hint)
    const blockHeights: number[] = [];
    for (const timestamp of timestamps) {
      const blockHeight = await timestampToAeHeight(
        timestamp.valueOf(),
        previousHeight,
        this.dataSource,
      );
      blockHeights.push(blockHeight);
      previousHeight = blockHeight;
    }

    // Store the actual startDate for range-based PNL calculations
    const actualStartDate = start;

    // Calculate block height for startDate once (for range-based PNL last snapshot)
    const startBlockHeight =
      useRangeBasedPnl && includePnl
        ? await timestampToAeHeight(
            actualStartDate.valueOf(),
            undefined,
            this.dataSource,
          )
        : undefined;

    const data = await Promise.all(
      timestamps.map(async (timestamp, index) => {
        // the aePriceHistory is an array of [timestamp_ms, price] pairs
        // we need to find the closest price to the timestamp
        const closestPrice = aePriceHistory.find(([priceTimeMs]) => {
          return priceTimeMs <= timestamp.valueOf();
        });
        const price = closestPrice ? closestPrice[1] : currentAePrice?.usd || 0;
        const blockHeight = blockHeights[index];
        // Prepare promises for parallel execution
        const promises: [
          Promise<string>,
          Promise<
            Awaited<ReturnType<typeof this.bclPnlService.calculateTokenPnls>>
          >,
          ...Array<
            Promise<
              Awaited<ReturnType<typeof this.bclPnlService.calculateTokenPnls>>
            >
          >,
        ] = [
          this.aeSdkService.sdk.getBalance(
            address as any,
            {
              height: blockHeight,
            } as any,
          ),
          // Always call without fromBlockHeight to get cumulative token values (all tokens owned)
          this.bclPnlService.calculateTokenPnls(
            address,
            blockHeight,
            undefined,
          ),
        ];

        // If range-based PNL is requested, calculate it separately for PNL fields only
        // Note: For index === 0, we use cumulative PNL (same as tokensPnl), so no need to call again
        let rangeBasedPnl:
          | Awaited<ReturnType<typeof this.bclPnlService.calculateTokenPnls>>
          | undefined = undefined;
        if (useRangeBasedPnl && includePnl && index > 0) {
          // For snapshots after the first: PNL from startDate to this timestamp
          // This allows hover to use PNL data directly from the snapshot
          // Calculate range-based PNL separately (will be used only for PNL fields)
          promises.push(
            this.bclPnlService.calculateTokenPnls(
              address,
              blockHeight,
              startBlockHeight,
            ),
          );
        }

        const results = await Promise.all(promises);
        const aeBalance = results[0];
        const tokensPnl = results[1]; // Cumulative token values (all tokens owned)
        if (useRangeBasedPnl && includePnl && results.length > 2) {
          rangeBasedPnl = results[2]; // Range-based PNL (only for PNL fields)
        }

        const balance = Number(toAe(aeBalance));

        // Use current value of tokens owned (from cumulative PNL service call)
        // This gives the actual current value: current holdings * current unit price
        // Token values must always be cumulative - all tokens owned at this block height
        const tokensValue = tokensPnl.totalCurrentValueAe;
        const tokensValueUsd = tokensPnl.totalCurrentValueUsd;

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
        if (includePnl) {
          // Use range-based PNL if available, otherwise use cumulative PNL
          // Token values (tokens_value_ae, tokens_value_usd) always use cumulative tokensPnl
          // PNL fields (invested, gain, percentage) use rangeBasedPnl when range-based PNL is enabled
          const pnlData = rangeBasedPnl || tokensPnl;

          // Calculate total PNL percentage
          const totalPnlPercentage =
            pnlData.totalCostBasisAe > 0
              ? (pnlData.totalGainAe / pnlData.totalCostBasisAe) * 100
              : 0;

          result.total_pnl = {
            percentage: totalPnlPercentage,
            invested: {
              ae: pnlData.totalCostBasisAe,
              usd: pnlData.totalCostBasisUsd,
            },
            current_value: {
              ae: pnlData.totalCurrentValueAe,
              usd: pnlData.totalCurrentValueUsd,
            },
            gain: {
              ae: pnlData.totalGainAe,
              usd: pnlData.totalGainUsd,
            },
          };

          // Only include range information when using range-based PnL
          if (useRangeBasedPnl) {
            // Determine the range for this PnL calculation
            // For range-based PNL with hover support: each snapshot shows PNL from startDate to that timestamp
            // First snapshot: cumulative from start (null) to current timestamp
            // All other snapshots: from startDate to current timestamp
            const rangeFrom = index === 0 ? null : actualStartDate;
            const rangeTo = timestamp;
            result.total_pnl.range = {
              from: rangeFrom,
              to: rangeTo,
            };
          }

          // Include individual token PNL data (use range-based if available, otherwise cumulative)
          result.tokens_pnl = pnlData.pnls;
        }

        return result;
      }),
    );

    return data;
  }
}
