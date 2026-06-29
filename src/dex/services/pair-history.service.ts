import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { CURRENCIES } from '@/configs';
import { HistoricalDataDto } from '@/transactions/dto/historical-data.dto';
import { Contract, Encoded } from '@aeternity/aepp-sdk';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import moment, { Moment } from 'moment';
import { DataSource } from 'typeorm';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';
import { PairSummaryDto } from '../dto/pair-summary.dto';
import { Pair } from '../entities/pair.entity';
import { isSanePrice } from '../utils/price-sanity';
import { isWae, priceScale as priceScaleOf } from '../utils/dex-math';
import { clampLimit, clampPage } from '@/utils/pagination';

type ContractInstance = Awaited<ReturnType<typeof Contract.initialize>>;

/** Fiat currencies we can convert AE-denominated prices into. */
const SUPPORTED_CURRENCIES = new Set<string>(
  CURRENCIES.map(({ code }) => code),
);

export interface IGetPaginatedHistoricalDataProps {
  pair: Pair;
  interval: number; // number of seconds
  page: number;
  limit: number;
  convertTo?: string;
  fromToken?: string;
}
export interface IGetHistoricalDataProps {
  pair: Pair;
  interval: number;
  startDate: Moment;
  endDate: Moment;
  convertTo?: string;
  mode: 'normal' | 'aggregated';
}

export interface IOldestHistoryInfo {
  id: number;
  created_at: Date;
}

export interface ITransactionPreviewPrice {
  end_time: Date;
  last_price: string;
}

export interface ITransactionPreview {
  result: ITransactionPreviewPrice[];
  timeframe: string;
}

@Injectable()
export class PairHistoryService {
  contracts: Record<Encoded.ContractAddress, ContractInstance> = {};
  constructor(
    private aeSdkService: AeSdkService,

    @InjectDataSource() private readonly dataSource: DataSource,

    private aePricingService: AePricingService,
  ) {
    //
  }

  async getPaginatedHistoricalData(
    props: IGetPaginatedHistoricalDataProps,
  ): Promise<HistoricalDataDto[]> {
    const { fromToken, pair, interval, convertTo = 'ae' } = props;
    // Bound page/limit so a caller cannot request an unbounded candle window
    // (the candle CTE scans the pair's history before OFFSET/LIMIT is applied).
    const page = clampPage(props.page);
    const limit = clampLimit(props.limit);
    const offset = (page - 1) * limit;

    // The OHLC / volume values produced below are denominated in the pair's
    // base (quote) token — the `fromToken` side. `value` selects the matching
    // ratio/volume columns; baseToken/quoteToken drive decimal normalization
    // and the denomination label.
    const value = fromToken === 'token0' ? '0' : '1';
    const baseToken = value === '0' ? pair.token0 : pair.token1;
    const quoteToken = value === '0' ? pair.token1 : pair.token0;
    const baseIsWae = isWae(baseToken?.address);
    // The charted token is the quote side. WAE is wrapped AE, so when WAE itself
    // is the charted token its price in AE is definitionally 1 — the pool ratio
    // against some other base (e.g. IMAE) is NOT its AE price. We emit a flat 1
    // series for it instead of charting that unrelated ratio.
    const quoteIsWae = isWae(quoteToken?.address);

    // When the base token is WAE the values are in AE and can be converted to a
    // fiat currency, using the AE→currency rate *as of each candle's time*
    // (joined per-candle from the coin_prices snapshots, see the SQL below).
    // We validate up front so an unsupported currency or a non-AE pool fails
    // fast (400) before the expensive history query runs.
    const requestedCurrency = (convertTo || 'ae').toLowerCase();
    const convertToFiat = requestedCurrency !== 'ae';
    if (convertToFiat) {
      // The series is AE-denominated when the base is WAE, OR when the charted
      // token itself IS WAE (its AE price is a flat 1, so AE→fiat is just the
      // AE/currency rate over time). Only a genuinely non-AE pool can't convert.
      if (!baseIsWae && !quoteIsWae) {
        throw new BadRequestException(
          `Cannot convert price to ${requestedCurrency}: this pool is not quoted against AE (WAE).`,
        );
      }
      if (!SUPPORTED_CURRENCIES.has(requestedCurrency)) {
        throw new BadRequestException(
          `Unsupported convertTo currency: ${convertTo}`,
        );
      }
    }
    // Denomination label. For a non-WAE pool the OHLC values are priced in the
    // base token, NOT AE — label them with that token so clients don't treat
    // the series as AE-denominated.
    const convertedTo = convertToFiat
      ? requestedCurrency
      : baseIsWae || quoteIsWae
        ? 'ae'
        : (baseToken?.symbol ?? baseToken?.address ?? 'unknown');

    const queryRunner = this.dataSource.createQueryRunner();
    //"MAX(CAST(transactions.buy_price->>'ae' AS FLOAT)) AS max_buy_price",
    // Per-candle historical AE→currency rate, sourced from the coin_prices
    // snapshots: the latest snapshot at/just-before the candle's open, falling
    // back to the earliest snapshot for candles older than any snapshot. Only
    // added (with its $5 parameter) when actually converting to fiat.
    const conversionRateColumn = convertToFiat
      ? `,
          COALESCE(
            (
              SELECT cp.rates->>$5
              FROM coin_prices cp
              WHERE cp.created_at <= interval_start
              ORDER BY cp.created_at DESC
              LIMIT 1
            ),
            (
              SELECT cp.rates->>$5
              FROM coin_prices cp
              ORDER BY cp.created_at ASC
              LIMIT 1
            )
          ) as conversion_rate`
      : '';
    const params: (string | number)[] = [pair.address, interval, offset, limit];
    if (convertToFiat) {
      params.push(requestedCurrency);
    }
    let rawResults;
    try {
      rawResults = await queryRunner.query(
        `
        WITH transactions_in_intervals AS (
          SELECT 
            t.created_at,
            CAST(NULLIF(t.ratio${value}, 'NaN') AS decimal) as price,
            t.volume${value} as volume,
            (t.market_cap${value}) as market_cap,
            t.total_supply,
            to_timestamp(
              floor(extract(epoch from t.created_at) / $2) * $2
            ) as interval_start
          FROM pair_transactions t
          WHERE t.pair_address = $1
            AND t.ratio${value} != 'NaN'
        ),
        grouped_intervals AS (
          SELECT DISTINCT interval_start
          FROM transactions_in_intervals
          ORDER BY interval_start DESC
          OFFSET $3
          LIMIT $4
        ),
        interval_stats AS (
          SELECT 
            t.interval_start,
            MIN(t.created_at) as "timeMin",
            MAX(t.created_at) as "timeMax",
            SUM(COALESCE(t.volume, 0)) as volume,
            MAX(t.market_cap) as market_cap,
            MAX(t.total_supply) as total_supply,
            MIN(t.price) as low,
            MAX(t.price) as high,
            FIRST_VALUE(t.price) OVER (
              PARTITION BY t.interval_start 
              ORDER BY t.created_at ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
            ) as open,
            FIRST_VALUE(t.price) OVER (
              PARTITION BY t.interval_start 
              ORDER BY t.created_at DESC
              ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
            ) as close,
            t.created_at,
            t.price
          FROM transactions_in_intervals t
          INNER JOIN grouped_intervals g ON g.interval_start = t.interval_start
          GROUP BY t.interval_start, t.created_at, t.price
        )
        SELECT 
          interval_start as "timeOpen",
          interval_start + make_interval(secs => $2) as "timeClose",
          MIN(low) as low,
          MAX(high) as high,
          MIN(open) as open,
          MAX(close) as close,
          SUM(volume) as volume,
          MAX(market_cap) as market_cap,
          MAX(total_supply) as total_supply,
          MIN("timeMin") as "timeMin",
          MAX("timeMax") as "timeMax",
          LAG(MAX(close)) OVER (ORDER BY interval_start) as previous_close${conversionRateColumn}
        FROM interval_stats
        GROUP BY interval_start
        ORDER BY interval_start ASC
      `,
        params,
      );
    } finally {
      await queryRunner.release();
    }

    // If any candle has no coin_prices snapshot at all (empty table), degrade
    // to the latest known rate for those candles instead of dropping the
    // conversion. Fetched once, only when needed.
    let fallbackRate: BigNumber | null = null;
    if (
      convertToFiat &&
      rawResults.some((row) => row.conversion_rate == null)
    ) {
      const rates = await this.aePricingService.getCurrencyRates();
      const latest = rates[requestedCurrency as keyof typeof rates];
      fallbackRate =
        latest != null && Number.isFinite(Number(latest))
          ? new BigNumber(latest)
          : null;
    }

    // Returns null when converting to fiat but no rate is available for this
    // candle (no per-candle snapshot and no usable fallback from
    // getCurrencyRates). Such candles must be omitted rather than emitted at
    // rate 1 — that would leave AE-sized OHLC/volume mislabeled as the fiat
    // currency.
    const rateFor = (row: any): BigNumber | null => {
      if (!convertToFiat) {
        return new BigNumber(1);
      }
      if (row.conversion_rate != null) {
        return new BigNumber(row.conversion_rate);
      }
      return fallbackRate;
    };

    // `ratio0`/`ratio1` are derived from RAW on-chain reserves, so a stored
    // ratio only equals a real price when both tokens share the same decimals.
    // Normalise every candle's price to human units using the pair's token
    // decimals: price_human = ratio_raw * 10^(quoteDecimals - baseDecimals),
    // where the base (quote-currency) token is the `fromToken` side and the
    // quote (charted) token is the other side. Without this, prices for any
    // non-18-decimal token are off by 10^(18 - tokenDecimals).
    const baseDecimals = Number(baseToken?.decimals ?? 18);
    const quoteDecimals = Number(quoteToken?.decimals ?? 18);
    const priceScale = priceScaleOf(quoteDecimals, baseDecimals);
    // Volume is the SUM of raw base-token amounts (volume0/volume1). Normalise
    // it to human units (÷ 10^baseDecimals) so it is consistent with the human
    // prices and so fiat conversion (× rate) is correct instead of off by
    // 10^baseDecimals.
    const volumeScale = new BigNumber(10).pow(-baseDecimals);

    // Price-side conversion: raw ratio → human units (priceScale) → fiat (rate,
    // which is 1 for AE). Always applies priceScale, so AE prices are corrected
    // too — we can no longer preserve the raw string byte-for-byte.
    const toPriceString = (raw: unknown, rate: BigNumber): string =>
      new BigNumber((raw as any) || '0')
        .multipliedBy(priceScale)
        .multipliedBy(rate)
        .toString();

    // WAE-as-charted-token: its AE price is a flat 1 (× rate for fiat), never the
    // pool ratio against the base token.
    const priceFor = (raw: unknown, rate: BigNumber): string =>
      quoteIsWae ? rate.toString() : toPriceString(raw, rate);

    // Modify the mapping to handle the previous close price correctly
    let lastClose: string | null = null;
    return rawResults
      .map((row) => {
        const rate = rateFor(row);
        if (rate === null) {
          // Fiat conversion requested but no usable rate for this candle —
          // omit it instead of mislabeling AE-sized values as the fiat currency.
          return null;
        }
        const close = priceFor(row.close, rate);
        const open = lastClose !== null ? lastClose : priceFor(row.open, rate);
        const high = priceFor(row.high, rate);
        const low = priceFor(row.low, rate);
        // Drop candles whose price is a dust-state artifact (non-finite or beyond
        // the chartable range) rather than emitting an unplottable spike. Don't
        // advance lastClose past a dropped candle.
        if (![close, open, high, low].every(isSanePrice)) {
          return null;
        }
        const result = {
          timeOpen: row.timeOpen,
          timeClose: row.timeClose,
          timeHigh: row.timeMax,
          timeLow: row.timeMin,
          quote: {
            convertedTo,
            open,
            high,
            low,
            close,
            volume: new BigNumber(row.volume || '0')
              .multipliedBy(volumeScale)
              .multipliedBy(rate)
              .toNumber(),
            // market_cap and total_supply are not populated for DEX pairs (the
            // sync layer never writes per-token market caps, and `total_supply`
            // on a transaction is the sum of raw reserves, not the LP supply),
            // so we return null rather than presenting a fabricated 0.
            market_cap: null,
            total_supply: null,
            timestamp: row.timeClose,
            symbol: quoteToken?.symbol ?? pair.token0?.symbol,
          },
        };
        lastClose = close;
        return result;
      })
      .filter((candle) => candle !== null);
  }

  // async getHistoricalData(
  //   props: IGetHistoricalDataProps,
  // ): Promise<HistoricalDataDto[]> {
  //   const { startDate, endDate } = props;

  //   const data = await this.transactionsRepository
  //     .createQueryBuilder('transactions')
  //     .where('transactions.sale_address = :sale_address', {
  //       sale_address: props.token.sale_address,
  //     })
  //     .andWhere('transactions.created_at >= :start', {
  //       start: startDate.toDate(),
  //     })
  //     .andWhere('transactions.created_at <= :endDate', {
  //       endDate: endDate.toDate(),
  //     })
  //     .orderBy('transactions.created_at', 'ASC')
  //     .getMany();

  //   const firstBefore =
  //     props.mode === 'aggregated'
  //       ? await this.transactionsRepository
  //         .createQueryBuilder('transactions')
  //         .where('transactions.sale_address = :sale_address', {
  //           sale_address: props.token.sale_address,
  //         })
  //         .andWhere('transactions.created_at < :start', {
  //           start: startDate.toDate(),
  //         })
  //         .orderBy('transactions.created_at', 'DESC')
  //         .limit(1)
  //         .getOne()
  //       : undefined;

  //   return this.processAggregatedHistoricalData(
  //     data,
  //     props,
  //     firstBefore,
  //     props.mode === 'aggregated',
  //   );
  // }

  // private processAggregatedHistoricalData(
  //   data: Transaction[],
  //   props: IGetHistoricalDataProps,
  //   initialPreviousData: Transaction | undefined = undefined,
  //   fillGaps: boolean,
  // ): HistoricalDataDto[] {
  //   const { startDate, endDate, interval } = props;

  //   const result: HistoricalDataDto[] = [];
  //   let intervalStart = startDate.toDate().getTime();
  //   const endTimestamp = endDate.toDate().getTime();
  //   const intervalDuration = interval * 1000;
  //   // const intervalDuration = this.getIntervalDuration(interval);

  //   let previousData: Transaction | undefined = initialPreviousData;

  //   while (intervalStart < endTimestamp) {
  //     const intervalEnd = intervalStart + intervalDuration;
  //     const intervalData = data.filter((record) => {
  //       if (!record?.buy_price?.ae || (record?.buy_price?.ae as any) == 'NaN') {
  //         return false;
  //       }
  //       const recordTime = record.created_at.getTime();
  //       return recordTime >= intervalStart && recordTime < intervalEnd;
  //     });

  //     if (intervalData.length) {
  //       const aggregatedData = this.aggregateIntervalData(
  //         intervalData,
  //         intervalStart,
  //         intervalEnd,
  //         props,
  //       );
  //       result.push(aggregatedData);
  //       previousData = this.advancedConvertAggregatedDataToTransaction(
  //         intervalData[intervalData.length - 1],
  //       );
  //     } else if (fillGaps && previousData) {
  //       result.push(
  //         this.aggregateIntervalData(
  //           [previousData],
  //           intervalStart,
  //           intervalEnd,
  //           props,
  //         ),
  //       );
  //     } else {
  //       // Handle the case where there's no previous data and no interval data.
  //       // For example, set a default value or continue.
  //     }

  //     intervalStart = intervalEnd;
  //   }

  //   return result.map((item, index) => {
  //     const previousItem = index > 0 ? result[index - 1] : null;
  //     if (previousItem) {
  //       item.quote.open = previousItem.quote.close;
  //     }
  //     return item;
  //   });
  //   // return result;
  // }

  // private aggregateIntervalData(
  //   intervalData: Transaction[],
  //   intervalStart: number,
  //   intervalEnd: number,
  //   props: IGetHistoricalDataProps,
  // ): HistoricalDataDto {
  //   // console.log('aggregateIntervalData->intervalData::', intervalData);
  //   const open = intervalData[0];
  //   const close = intervalData[intervalData.length - 1];

  //   let high = open;
  //   let low = open;
  //   let volume = 0;
  //   let total_supply = new BigNumber(0);
  //   let market_cap = new BigNumber(0);

  //   intervalData.forEach((record) => {
  //     if (record.buy_price[props.convertTo] > high.buy_price[props.convertTo]) {
  //       high = record;
  //     }
  //     if (record.buy_price[props.convertTo] < low.buy_price[props.convertTo]) {
  //       low = record;
  //     }
  //     volume += record.volume?.toNumber() ?? 0;
  //     total_supply = record.total_supply;
  //     market_cap = record.market_cap[props.convertTo];
  //   });

  //   let open_buy_price: any = open.buy_price;

  //   if (open_buy_price?.ae == 'NaN') {
  //     if ((open?.previous_buy_price?.ae as any) != 'NaN') {
  //       open_buy_price = open.previous_buy_price;
  //     }
  //   }

  //   function getPrice(object: Transaction, convertTo, isOpenTrade = false) {
  //     let final_buy_price: any = object.buy_price;

  //     if (
  //       !!open?.previous_buy_price?.ae &&
  //       (final_buy_price?.ae == 'NaN' ||
  //         (object.tx_type === TX_FUNCTIONS.create_community && isOpenTrade))
  //     ) {
  //       final_buy_price = open.previous_buy_price;
  //     }

  //     // TODO: when no price is found the candle data should be excluded
  //     if (!final_buy_price) {
  //       return 0;
  //     }

  //     return final_buy_price[convertTo];
  //   }

  //   return {
  //     timeOpen: new Date(intervalStart),
  //     timeClose: new Date(intervalEnd - 1),
  //     timeHigh: high.created_at,
  //     timeLow: low.created_at,
  //     quote: {
  //       convertedTo: props.convertTo,
  //       open: getPrice(open, props.convertTo, true),
  //       high: getPrice(high, props.convertTo),
  //       low: getPrice(low, props.convertTo),
  //       close: getPrice(close, props.convertTo),
  //       volume: volume,
  //       market_cap,
  //       total_supply,
  //       timestamp: new Date(intervalEnd - 1),
  //       symbol: props.token.symbol,
  //     },
  //   };
  // }

  // private advancedConvertAggregatedDataToTransaction(
  //   aggregatedData: Transaction,
  // ): Transaction {
  //   const tokenHistory = new Transaction();
  //   Object.keys(aggregatedData).forEach((key) => {
  //     tokenHistory[key] = aggregatedData[key];
  //   });
  //   // tokenHistory.price = { value: aggregatedData.quote.close } as any; // Ensure type compatibility
  //   // tokenHistory.sell_price = tokenHistory.price; // Adjust as per your entity structure
  //   // tokenHistory.market_cap = { value: aggregatedData.quote.market_cap } as any; // Ensure type compatibility
  //   // // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  //   // // @ts-ignore
  //   // tokenHistory.total_supply = aggregatedData.quote.volume;
  //   // tokenHistory.created_at = aggregatedData.timeClose;
  //   return tokenHistory;
  // }

  async getForPreview(pair: Pair, intervalType: '1d' | '7d' | '30d') {
    if (!pair) return { result: [], timeframe: '' };
    const types = {
      '1d': {
        interval: '20 minutes',
        unit: 'minute',
        size: 20,
        timeframe: '1 day',
      },
      '7d': {
        interval: '1 hour',
        unit: 'hour',
        size: 1,
        timeframe: '7 days',
      },
      '30d': {
        interval: '4 hours',
        unit: 'hour',
        size: 4,
        timeframe: '30 days',
      },
    };
    // The `intervalType` type is a compile-time hint only — the HTTP layer can
    // still pass any string. Fall back to '7d' rather than destructuring
    // `undefined` (which would throw a 500) for an unrecognised value.
    const { interval, unit, size, timeframe } =
      types[intervalType] ?? types['7d'];

    const queryRunner = this.dataSource.createQueryRunner();

    try {
      // Create dynamic truncation based on the interval unit and size
      const truncationQuery =
        size > 1
          ? `DATE_TRUNC('${unit}', created_at) + INTERVAL '${size} ${unit}' * FLOOR(EXTRACT('${unit}' FROM created_at) / ${size})`
          : `DATE_TRUNC('${unit}', created_at)`; // For single units like '1 day'

      // The LAST (most recent) ratio in each bucket is the bucket's price. The
      // old code used MAX(ratio1) — the bucket's *highest* ratio, mislabeled as
      // `last_price`, which also let a single dust-state transaction (exploded
      // ratio) define the whole bucket. DISTINCT ON + ORDER BY created_at DESC
      // picks the genuine last value per bucket instead.
      const data = await queryRunner.query(
        `
          SELECT DISTINCT ON (truncated_time)
            truncated_time,
            last_ratio1
          FROM (
            SELECT
              ${truncationQuery} AS truncated_time,
              CAST(NULLIF(ratio1, 'NaN') AS decimal) AS last_ratio1,
              created_at
            FROM pair_transactions
            WHERE pair_address = $1
              AND created_at >= NOW() - INTERVAL '${timeframe}'
              AND ratio1 != 'NaN'
          ) sub
          ORDER BY truncated_time DESC, created_at DESC
        `,
        [pair.address],
      );

      // Price the series consistently in one direction: ratio1 (reserve1 /
      // reserve0) = token0 priced in token1, decimal-normalized. Returns null for
      // a dust-state artifact (beyond the chartable range) so it is dropped
      // rather than spiking the preview.
      const dec0 = Number(pair.token0?.decimals ?? 18);
      const dec1 = Number(pair.token1?.decimals ?? 18);
      const ratio1Scale = priceScaleOf(dec0, dec1);
      const toPrice = (rawRatio1: unknown): string | null => {
        if (rawRatio1 == null) {
          return null;
        }
        const price = new BigNumber(String(rawRatio1)).multipliedBy(
          ratio1Scale,
        );
        return isSanePrice(price) ? price.toString() : null;
      };

      let result;
      if (data.length <= 1) {
        // If no transactions found for interval, get latest 4 transactions
        const latestTransactions = await queryRunner.query(
          `
            SELECT
              created_at as truncated_time,
              CAST(NULLIF(ratio1, 'NaN') AS decimal) as last_ratio1
            FROM pair_transactions
            WHERE pair_address = $1
              AND ratio1 != 'NaN'
            ORDER BY created_at DESC
            LIMIT 4
          `,
          [pair.address],
        );

        result = latestTransactions
          .map((item) => ({
            last_price: toPrice(item.last_ratio1),
            end_time: item.truncated_time,
          }))
          .filter((item) => item.last_price !== null);
      } else {
        result = data
          .map((item) => ({
            last_price: toPrice(item.last_ratio1),
            end_time: item.truncated_time,
          }))
          .filter((item) => item.last_price !== null);
      }

      // prevent duplicate with same end_time
      result = result.filter(
        (item, index) =>
          index ==
          result.findIndex((t) =>
            moment(t.end_time).isSame(moment(item.end_time)),
          ),
      );

      return {
        result,
        count: result.length,
        timeframe,
        interval,
        pair,
      } as ITransactionPreview;
    } finally {
      await queryRunner.release();
    }
  }

  async calculatePairSummary(
    pair: Pair,
    token?: string,
  ): Promise<PairSummaryDto> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      // Determine which token to use for volume calculations
      let volumeToken = '0'; // Default to token0
      const isToken0WAE = isWae(pair.token0?.address);
      const isToken1WAE = isWae(pair.token1?.address);

      // Determine which token to use based on parameter or WAE default
      if (token) {
        // If token parameter is provided, use it
        if (token === pair.token0?.address) {
          volumeToken = '0';
        } else if (token === pair.token1?.address) {
          volumeToken = '1';
        } else {
          // If token doesn't match either token in the pair, default to token0
          volumeToken = '0';
        }
      } else {
        // If no token specified, default to WAE if available
        if (isToken0WAE) {
          volumeToken = '0';
        } else if (isToken1WAE) {
          volumeToken = '1';
        } else {
          // If no WAE found, default to token0
          volumeToken = '0';
        }
      }
      // Total AE volume for the pair = the WAE side that actually moved, taken
      // DIRECTLY. An earlier version reconstructed the non-WAE selected token's
      // volume as `token_volume * (reserveWAE / reserveOther)`, which explodes
      // for any transaction recorded while one reserve is at dust (1 wei) and
      // inflated totals by orders of magnitude — there is no isSanePrice guard
      // on this aggregate to catch it. The WAE leg is the real AE amount and is
      // dust-safe, so the AE volume does not depend on which token is selected.
      // This mirrors the same fix already applied in DexTokenSummaryService.
      // Pairs with no WAE side yield 0 (no token price to convert with).
      // NB: do NOT pass an unreferenced parameter — Postgres cannot infer its
      // type and aborts the whole query with "could not determine data type of
      // parameter $N". $2 is the WAE address (used in the CASE).
      const volumeResult = await queryRunner.query(
        `
          SELECT
            COALESCE(SUM(
              CASE
                WHEN token0.address = $2 THEN pt.volume0 / POW(10, token0.decimals)
                WHEN token1.address = $2 THEN pt.volume1 / POW(10, token1.decimals)
                ELSE 0
              END
            ), 0) as total_volume
          FROM pair_transactions pt
          INNER JOIN pairs p ON pt.pair_address = p.address
          INNER JOIN dex_tokens token0 ON p.token0_address = token0.address
          INNER JOIN dex_tokens token1 ON p.token1_address = token1.address
          WHERE pt.pair_address = $1
            AND pt.tx_type IN (
              'swap_exact_tokens_for_tokens',
              'swap_tokens_for_exact_tokens',
              'swap_exact_tokens_for_ae',
              'swap_tokens_for_exact_ae',
              'swap_exact_ae_for_tokens',
              'swap_ae_for_exact_tokens'
            )
        `,
        [pair.address, DEX_CONTRACTS.wae],
      );

      // Get data for different time periods
      const now = moment();
      const periods = {
        '24h': now.clone().subtract(24, 'hours'),
        '7d': now.clone().subtract(7, 'days'),
        '30d': now.clone().subtract(30, 'days'),
      };

      const periodData = {};

      for (const [period, startDate] of Object.entries(periods)) {
        // Period AE volume — same dust-safe WAE-leg conversion as the total.
        // $3 is the WAE address; no unreferenced params (see total query above).
        const periodVolumeResult = await queryRunner.query(
          `
            SELECT
              COALESCE(SUM(
                CASE
                  WHEN token0.address = $3 THEN pt.volume0 / POW(10, token0.decimals)
                  WHEN token1.address = $3 THEN pt.volume1 / POW(10, token1.decimals)
                  ELSE 0
                END
              ), 0) as total_volume
            FROM pair_transactions pt
            INNER JOIN pairs p ON pt.pair_address = p.address
            INNER JOIN dex_tokens token0 ON p.token0_address = token0.address
            INNER JOIN dex_tokens token1 ON p.token1_address = token1.address
            WHERE pt.pair_address = $1
              AND pt.created_at >= $2
              AND pt.tx_type IN (
                'swap_exact_tokens_for_tokens',
                'swap_tokens_for_exact_tokens',
                'swap_exact_tokens_for_ae',
                'swap_tokens_for_exact_ae',
                'swap_exact_ae_for_tokens',
                'swap_ae_for_exact_tokens'
              )
          `,
          [pair.address, startDate.toDate(), DEX_CONTRACTS.wae],
        );

        // Get price changes for the period
        // We want the price of the OTHER token in terms of the selected token
        // If volumeToken is '0' (WAE), we want ratio1 (token1/token0) - price of token1 in terms of token0 (WAE)
        // If volumeToken is '1' (WAE), we want ratio0 (token0/token1) - price of token0 in terms of token1 (WAE)
        const otherToken = volumeToken === '0' ? '1' : '0';
        const priceResult = await queryRunner.query(
          `
            SELECT 
              (SELECT ratio${otherToken} FROM pair_transactions 
               WHERE pair_address = $1 AND created_at >= $2 
               ORDER BY created_at ASC LIMIT 1) as start_price,
              (SELECT ratio${otherToken} FROM pair_transactions 
               WHERE pair_address = $1 
               ORDER BY created_at DESC LIMIT 1) as current_price
          `,
          [pair.address, startDate.toDate()],
        );

        // Calculate volume in AE
        const periodVolumeAE = new BigNumber(
          periodVolumeResult[0]?.total_volume || 0,
        );

        // Calculate price change
        const priceData = priceResult[0];
        let priceChange = {
          percentage: '0.00',
          value: '0',
        };

        if (priceData && priceData.start_price && priceData.current_price) {
          // Raw ratios → human price so the dust-sanity check is decimal-correct
          // (ratio0 = reserve0/reserve1 normalises by 10^(dec1-dec0), and vice
          // versa). The % itself is scale-invariant; we normalise so the bound
          // and the reported `value` are meaningful.
          const dec0 = Number(pair.token0?.decimals ?? 18);
          const dec1 = Number(pair.token1?.decimals ?? 18);
          const priceScale =
            otherToken === '0'
              ? priceScaleOf(dec1, dec0)
              : priceScaleOf(dec0, dec1);
          const startPrice = new BigNumber(priceData.start_price).multipliedBy(
            priceScale,
          );
          const currentPrice = new BigNumber(
            priceData.current_price,
          ).multipliedBy(priceScale);

          // Skip when either endpoint is a dust-state artifact — it would report
          // a meaningless multi-million-percent swing for a drained pool.
          if (
            isSanePrice(startPrice) &&
            isSanePrice(currentPrice) &&
            !startPrice.isZero()
          ) {
            const changeValue = currentPrice.minus(startPrice);
            const changePercentage = changeValue
              .dividedBy(startPrice)
              .multipliedBy(100);

            priceChange = {
              percentage: changePercentage.toString(),
              value: changeValue.toString(),
            };
          }
        }

        // Get price data for the period volume in multiple currencies
        const periodVolumePriceData =
          await this.aePricingService.getPriceData(periodVolumeAE);
        periodData[period] = {
          volume: periodVolumePriceData,
          price_change: priceChange,
        };
      }

      // Calculate total volume in AE for the selected token
      const totalVolumeAE = new BigNumber(volumeResult[0]?.total_volume || 0);

      // Get price data for total volume in multiple currencies
      const totalVolumePriceData =
        await this.aePricingService.getPriceData(totalVolumeAE);

      return {
        address: pair.address,
        volume_token:
          volumeToken === '0' ? pair.token0?.address : pair.token1?.address,
        token_position: volumeToken,
        total_volume: totalVolumePriceData,
        change: {
          '24h': periodData['24h'],
          '7d': periodData['7d'],
          '30d': periodData['30d'],
        },
        volumeResult,
      } as any;
    } finally {
      await queryRunner.release();
    }
  }
}
