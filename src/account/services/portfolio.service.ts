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
import { ACTIVE_NETWORK, AETERNITY_COIN_ID } from '@/configs';
import { toAe } from '@aeternity/aepp-sdk';
import { batchTimestampToAeHeight } from '@/utils/getBlochHeight';
import {
  BclPnlService,
  DailyPnlWindow,
  TokenPnlResult,
} from './bcl-pnl.service';
import { fetchJson } from '@/utils/common';

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
  private readonly accountPubkeyPointerKey = 'account_pubkey';

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

    const resolvedAddress = await this.resolveAccountAddress(address);

    // Fetch price history and current price in parallel.
    // For historical prices, query the local coin_historical_prices table first
    // (populated by the background CoinGecko sync). Only fall back to the live
    // CoinGecko API when the DB has no data for the needed range.
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
    } else {
      // DB has no data for this range; fall back to live CoinGecko fetch.
      const daysNeeded = Math.ceil(now.diff(start, 'days', true)) + 3;
      const days = Math.min(365, Math.max(7, daysNeeded));
      aePriceHistory = await this.coinGeckoService
        .fetchHistoricalPrice(AETERNITY_COIN_ID, 'usd', days, 'daily')
        .then((prices) => prices.sort((a, b) => b[0] - a[0]));
    }
    // Resolve all block heights in a single batch query against the local key_blocks table.
    // Any timestamps not covered by the table (sync gaps) fall back to individual resolution.
    const targetTimestamps = timestamps.map((t) => t.valueOf());
    const heightMap = await batchTimestampToAeHeight(
      targetTimestamps,
      this.dataSource,
    );
    // Build the ordered block-height array.  If a timestamp was not resolved by
    // either key_blocks or transactions (extremely rare — would require a gap in
    // both tables), propagate the nearest already-resolved height rather than
    // silently falling back to 0 (genesis block), which would produce wrong
    // balances and PNL for that snapshot.
    let lastKnownHeight = 0;
    const blockHeights = targetTimestamps.map((ts) => {
      const h = heightMap.get(ts);
      if (h !== undefined) {
        lastKnownHeight = h;
        return h;
      }
      this.logger.warn(
        `[batchTimestampToAeHeight] Could not resolve block height for ts=${ts}; ` +
          `using nearest known height ${lastKnownHeight}`,
      );
      return lastKnownHeight;
    });
    const uniqueBlockHeights = [...new Set(blockHeights)];

    // Build per-day windows for the daily PnL calendar.
    // Each snapshot's window covers [previousTimestamp, currentTimestamp).
    // The first snapshot gets a zero-width window (dayStart === snapshotTs)
    // so it naturally returns 0 gain since no sells can fall in an empty range.
    const dailyWindows: DailyPnlWindow[] = timestamps.map((ts, i) => ({
      snapshotTs: ts.valueOf(),
      dayStartTs: i > 0 ? timestamps[i - 1].valueOf() : ts.valueOf(),
    }));

    // Pre-compute PNL for all unique block heights in a single batch query.
    // This replaces the previous per-snapshot SQL calls (N queries → 1 query).
    const [pnlMap, dailyPnlMap] = await Promise.all([
      this.bclPnlService.calculateTokenPnlsBatch(
        resolvedAddress,
        uniqueBlockHeights,
        undefined,
      ),
      includePnl && useRangeBasedPnl
        ? this.bclPnlService.calculateDailyPnlBatch(
            resolvedAddress,
            dailyWindows,
          )
        : Promise.resolve(undefined as Map<number, TokenPnlResult> | undefined),
    ]);
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
          resolvedAddress,
          blockHeight,
        );

        const tokensPnl = pnlMap.get(blockHeight) ?? emptyPnl;

        // Daily PnL is keyed by snapshot timestamp (ms), giving each day its
        // own isolated sell window regardless of block height deduplication.
        const rangeBasedPnl =
          useRangeBasedPnl && includePnl
            ? (dailyPnlMap?.get(timestamp.valueOf()) ?? undefined)
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
            // Each snapshot shows PnL for its own day window:
            // from the previous snapshot timestamp (or null for the first) to this snapshot.
            const rangeFrom = index === 0 ? null : timestamps[index - 1];
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

    return data;
  }

  private async resolveAccountAddress(address: string): Promise<string> {
    if (!address || address.startsWith('ak_') || !address.includes('.')) {
      return address;
    }

    try {
      const response = await fetchJson<{
        owner?: string;
        pointers?: Array<{
          key?: string;
          encoded_key?: string;
          id?: string;
        }>;
      }>(`${ACTIVE_NETWORK.url}/v3/names/${encodeURIComponent(address)}`);

      const accountPointer = response?.pointers?.find(
        (pointer) =>
          pointer?.key === this.accountPubkeyPointerKey &&
          typeof pointer.id === 'string' &&
          pointer.id.startsWith('ak_'),
      )?.id;

      if (accountPointer) {
        return accountPointer;
      }

      if (response?.owner?.startsWith('ak_')) {
        return response.owner;
      }
    } catch (error) {
      this.logger.warn(
        `Failed to resolve account reference ${address}, falling back to raw value`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return address;
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

    const promise = this.aeSdkService.sdk.getBalance(
      address as any,
      {
        height: bucketHeight,
      } as any,
    );
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
