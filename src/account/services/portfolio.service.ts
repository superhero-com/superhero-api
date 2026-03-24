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
import { CoinHistoricalPriceService } from '@/ae-pricing/services/coin-historical-price.service';
import { AETERNITY_COIN_ID } from '@/configs';
import { toAe } from '@aeternity/aepp-sdk';
import { batchTimestampToAeHeight } from '@/utils/getBlochHeight';
import { BclPnlService, TokenPnlResult } from './bcl-pnl.service';

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
  private readonly snapshotConcurrency = 15;
  /**
   * Balance granularity bucket size in key blocks.
   * Block heights are floored to the nearest multiple of this value before
   * calling getBalance, so that snapshots within the same 300-block window
   * (~15 hours) share a single AE node lookup instead of each making a
   * separate slow historical-state request.
   */
  private readonly BALANCE_BUCKET_SIZE = 300;

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
    private readonly coinHistoricalPriceService: CoinHistoricalPriceService,
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

    const t0 = Date.now();
    const _perfLines: string[] = [];
    const perfLog = (label: string, since = t0) => {
      const line = `[perf] ${label}: ${Date.now() - since}ms (total: ${Date.now() - t0}ms) | addr=${address.slice(0, 12)} snapshots=${timestamps.length}`;
      this.logger.log(line);
      _perfLines.push(line);
    };
    // Write accumulated perf lines to a temp file so they can be read even
    // when the server stdout is not directly accessible.
    const _flushPerf = () => {
      try {
        require('fs').writeFileSync(
          '/tmp/portfolio-perf.log',
          _perfLines.join('\n') + '\n',
        );
      } catch {}
    };

    // Fetch price history and current price in parallel.
    // For historical prices, query the local coin_historical_prices table first
    // (populated by the background CoinGecko sync). Only fall back to the live
    // CoinGecko API when the DB has no data for the needed range.
    const tCG = Date.now();

    // Extend start backward a few days so the first snapshot always has a price
    // data point at or before it, even when the range starts close to midnight.
    const priceRangeStartMs = start.clone().subtract(3, 'days').valueOf();
    const priceRangeEndMs = end.valueOf();

    const [dbPriceRows, currentAePrice] = await Promise.all([
      this.coinHistoricalPriceService.getHistoricalPriceData(
        AETERNITY_COIN_ID,
        'usd',
        priceRangeStartMs,
        priceRangeEndMs,
      ),
      this.coinGeckoService.getPriceData(new BigNumber(1)),
    ]);

    let aePriceHistory: Array<[number, number]>;
    if (dbPriceRows.length > 0) {
      // DB data sorted ascending — reverse to match the descending order
      // expected by findClosestHistoricalPrice.
      aePriceHistory = dbPriceRows.reverse();
      this.logger.debug(
        `[perf] prices from DB: ${dbPriceRows.length} points`,
      );
    } else {
      // DB has no data for this range; fall back to live CoinGecko fetch.
      const daysNeeded = Math.ceil(now.diff(start, 'days', true)) + 3;
      const days = Math.min(365, Math.max(7, daysNeeded));
      aePriceHistory = await this.coinGeckoService
        .fetchHistoricalPrice(AETERNITY_COIN_ID, 'usd', days, 'daily')
        .then((prices) => prices.sort((a, b) => b[0] - a[0]));
    }
    perfLog('coingecko/prices', tCG);

    // Resolve all block heights in a single batch query against the local key_blocks table.
    // Any timestamps not covered by the table (sync gaps) fall back to individual resolution.
    const targetTimestamps = timestamps.map((t) => t.valueOf());
    const tHeights = Date.now();
    const heightMap = await batchTimestampToAeHeight(
      targetTimestamps,
      this.dataSource,
    );
    const blockHeights = targetTimestamps.map((ts) => heightMap.get(ts) ?? 0);
    perfLog(`batchTimestampToAeHeight → [${blockHeights.join(',')}]`, tHeights);

    // startBlockHeight is the block at the beginning of the requested range.
    // timestamps[0] === start (same millisecond value), so blockHeights[0] is
    // already the correct answer — no extra DB or API call needed.
    const startBlockHeight =
      useRangeBasedPnl && includePnl ? blockHeights[0] : undefined;

    const uniqueBlockHeights = [...new Set(blockHeights)];

    // Pre-compute PNL for all unique block heights in a single batch query.
    // This replaces the previous per-snapshot SQL calls (N queries → 1 query).
    const tPnl = Date.now();
    const [pnlMap, rangePnlMap] = await Promise.all([
      this.bclPnlService.calculateTokenPnlsBatch(
        address,
        uniqueBlockHeights,
        undefined,
      ),
      includePnl && useRangeBasedPnl && startBlockHeight !== undefined
        ? this.bclPnlService.calculateTokenPnlsBatch(
            address,
            uniqueBlockHeights,
            startBlockHeight,
          )
        : Promise.resolve(undefined as Map<number, TokenPnlResult> | undefined),
    ]);
    perfLog('calculateTokenPnlsBatch', tPnl);

    const emptyPnl: TokenPnlResult = {
      pnls: {},
      totalCostBasisAe: 0,
      totalCostBasisUsd: 0,
      totalCurrentValueAe: 0,
      totalCurrentValueUsd: 0,
      totalGainAe: 0,
      totalGainUsd: 0,
    };

    const balanceCache = new Map<number, Promise<string>>();
    const tBalance = Date.now();
    const data = await this.mapWithConcurrency(
      timestamps,
      this.snapshotConcurrency,
      async (timestamp, index) => {
        const price = this.findClosestHistoricalPrice(
          aePriceHistory,
          timestamp.valueOf(),
          currentAePrice?.usd || 0,
        );
        const blockHeight = blockHeights[index];

        // Balance still requires an external AE node call per unique block height
        const aeBalancePromise = this.getCachedBalance(
          balanceCache,
          address,
          blockHeight,
        );

        const tokensPnl = pnlMap.get(blockHeight) ?? emptyPnl;

        // For range-based PNL, index 0 reuses the cumulative result (existing semantics)
        const rangeBasedPnl =
          useRangeBasedPnl && includePnl && index > 0
            ? (rangePnlMap?.get(blockHeight) ?? undefined)
            : undefined;

        const aeBalance = await aeBalancePromise;
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
            const rangeFrom = index === 0 ? null : start;
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
      },
    );

    perfLog('getBalance + snapshot assembly', tBalance);
    perfLog('TOTAL');
    _flushPerf();
    return data;
  }

  private getCachedBalance(
    cache: Map<number, Promise<string>>,
    address: string,
    blockHeight: number,
  ): Promise<string> {
    // Snap to the nearest lower multiple of BALANCE_BUCKET_SIZE so that
    // all block heights within the same 300-block window share one AE node
    // call instead of each issuing a slow historical-state lookup.
    // e.g. heights 900–1199 all use height 900; heights 1200–1499 use 1200.
    const bucketHeight =
      Math.floor(blockHeight / this.BALANCE_BUCKET_SIZE) *
      this.BALANCE_BUCKET_SIZE;

    const cached = cache.get(bucketHeight);
    if (cached) {
      return cached;
    }

    const promise = this.aeSdkService.sdk.getBalance(address as any, {
      height: bucketHeight,
    } as any);
    cache.set(bucketHeight, promise);
    return promise;
  }

  private findClosestHistoricalPrice(
    priceHistory: Array<[number, number]>,
    targetTimestampMs: number,
    fallbackPrice: number,
  ): number {
    let left = 0;
    let right = priceHistory.length - 1;
    let closestPrice = fallbackPrice;

    // CoinGecko history is sorted descending by timestamp, so we binary search
    // for the newest sample that is still at or before the target timestamp.
    while (left <= right) {
      const middle = Math.floor((left + right) / 2);
      const [priceTimeMs, price] = priceHistory[middle];
      if (priceTimeMs <= targetTimestampMs) {
        closestPrice = price;
        right = middle - 1;
      } else {
        left = middle + 1;
      }
    }

    return closestPrice;
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(concurrency, 1), items.length);

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= items.length) {
          return;
        }
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    });

    await Promise.all(workers);
    return results;
  }
}
