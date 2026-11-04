import { PRICE_CURRENCY_CODES, TX_FUNCTIONS } from '@/configs';
import { Token } from '@/tokens/entities/token.entity';
import { clampLimit, clampPage } from '@/utils/pagination';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import type { Moment } from 'moment';
import { DataSource, Repository } from 'typeorm';
import { HistoricalDataDto } from '../dto/historical-data.dto';
import { Transaction } from '../entities/transaction.entity';

export interface IGetPaginatedHistoricalDataProps {
  token: Token;
  interval: number; // number of seconds
  page: number;
  limit: number;
  convertTo?: string;
}
export interface IGetHistoricalDataProps {
  token: Token;
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

function parseConvertTo(convertTo: unknown): string {
  const currency = String(convertTo || 'ae').toLowerCase();
  if (!PRICE_CURRENCY_CODES.includes(currency)) {
    throw new BadRequestException(
      `Unsupported convertTo currency: ${convertTo}`,
    );
  }
  return currency;
}

// 0 divides by zero in the candle SQL and a negative value never ends the
// gap-filling loop in processAggregatedHistoricalData.
function parseInterval(interval: unknown): number {
  const seconds = Number(interval);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new BadRequestException(
      'interval must be a positive whole number of seconds',
    );
  }
  return seconds;
}

@Injectable()
export class TransactionHistoryService {
  private readonly logger = new Logger(TransactionHistoryService.name);

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async getOldestHistoryInfo(address: string): Promise<IOldestHistoryInfo> {
    return await this.tokenRepository
      .createQueryBuilder('token')
      .select(['token.id as id', 'token.created_at as created_at'])
      .where('token.address = :address', { address })
      .orWhere('token.sale_address = :address', { address })
      .orderBy('token.created_at', 'ASC')
      .limit(1)
      .getRawOne<IOldestHistoryInfo>();
  }

  async getPaginatedHistoricalData(
    props: IGetPaginatedHistoricalDataProps,
  ): Promise<HistoricalDataDto[]> {
    const { token } = props;
    const convertTo = parseConvertTo(props.convertTo);
    const interval = parseInterval(props.interval);
    const page = clampPage(props.page);
    const limit = clampLimit(props.limit);
    const offset = (page - 1) * limit;

    //"MAX(CAST(transactions.buy_price->>'ae' AS FLOAT)) AS max_buy_price",
    const rawResults = await this.dataSource.query(
      `
        WITH transactions_in_intervals AS (
          SELECT 
            t.created_at,
            CAST(NULLIF(t.buy_price->>$3, 'NaN') AS decimal) as price,
            t.volume,
            (t.market_cap->>$3) as market_cap,
            t.total_supply,
            to_timestamp(
              floor(extract(epoch from t.created_at) / $2) * $2
            ) as interval_start
          FROM transactions t
          WHERE t.sale_address = $1
            AND t.buy_price->>$3 != 'NaN'
        ),
        grouped_intervals AS (
          SELECT DISTINCT interval_start
          FROM transactions_in_intervals
          ORDER BY interval_start DESC
          OFFSET $4
          LIMIT $5
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
          LAG(MAX(close)) OVER (ORDER BY interval_start) as previous_close
        FROM interval_stats
        GROUP BY interval_start
        ORDER BY interval_start ASC
      `,
      [token.sale_address, interval, convertTo, offset, limit],
    );

    // Modify the mapping to handle the previous close price correctly
    let lastClose = null;
    return rawResults.map((row) => {
      const result = {
        timeOpen: row.timeOpen,
        timeClose: row.timeClose,
        timeHigh: row.timeMax,
        timeLow: row.timeMin,
        quote: {
          convertedTo: convertTo,
          open: lastClose !== null ? lastClose : String(row.open || '0'),
          high: String(row.high || '0'),
          low: String(row.low || '0'),
          close: String(row.close || '0'),
          volume: parseFloat(row.volume || '0'),
          market_cap: new BigNumber(row.market_cap || '0'),
          total_supply: new BigNumber(row.total_supply || '0'),
          timestamp: row.timeClose,
          symbol: token.symbol,
        },
      };
      lastClose = String(row.close || '0');
      return result;
    });
  }

  private static readonly MAX_HISTORICAL_ROWS = 10_000;
  // The candle loop walks (and gap filling emits) every interval in the range,
  // traded or not. 3,000 still fits 1-minute candles over the default 2 days.
  static readonly MAX_HISTORICAL_CANDLES = 3_000;

  async getHistoricalData(
    rawProps: IGetHistoricalDataProps,
  ): Promise<HistoricalDataDto[]> {
    const props: IGetHistoricalDataProps = {
      ...rawProps,
      convertTo: parseConvertTo(rawProps.convertTo),
      interval: parseInterval(rawProps.interval),
    };
    const { startDate, endDate } = props;
    if (!startDate.isValid() || !endDate.isValid()) {
      throw new BadRequestException(
        'start_date and end_date must be valid dates',
      );
    }
    const candles = endDate.diff(startDate) / (props.interval * 1000);
    if (candles > TransactionHistoryService.MAX_HISTORICAL_CANDLES) {
      throw new BadRequestException(
        `Date range spans more than ${TransactionHistoryService.MAX_HISTORICAL_CANDLES} intervals; use a larger interval or a shorter range`,
      );
    }

    const data = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .where('transactions.sale_address = :sale_address', {
        sale_address: props.token.sale_address,
      })
      .andWhere('transactions.created_at >= :start', {
        start: startDate.toDate(),
      })
      .andWhere('transactions.created_at <= :endDate', {
        endDate: endDate.toDate(),
      })
      .orderBy('transactions.created_at', 'ASC')
      .take(TransactionHistoryService.MAX_HISTORICAL_ROWS)
      .getMany();

    if (data.length >= TransactionHistoryService.MAX_HISTORICAL_ROWS) {
      this.logger.warn(
        `Historical data for ${props.token.sale_address} truncated at ${TransactionHistoryService.MAX_HISTORICAL_ROWS} rows`,
      );
    }

    const firstBefore =
      props.mode === 'aggregated'
        ? await this.transactionsRepository
            .createQueryBuilder('transactions')
            .where('transactions.sale_address = :sale_address', {
              sale_address: props.token.sale_address,
            })
            .andWhere('transactions.created_at < :start', {
              start: startDate.toDate(),
            })
            .orderBy('transactions.created_at', 'DESC')
            .limit(1)
            .getOne()
        : undefined;

    return this.processAggregatedHistoricalData(
      data,
      props,
      firstBefore,
      props.mode === 'aggregated',
    );
  }

  private processAggregatedHistoricalData(
    data: Transaction[],
    props: IGetHistoricalDataProps,
    initialPreviousData: Transaction | undefined = undefined,
    fillGaps: boolean,
  ): HistoricalDataDto[] {
    const { startDate, endDate, interval } = props;

    // Pre-filter invalid records once (data is already sorted by created_at ASC)
    const validData = data.filter(
      (record) =>
        record?.buy_price?.ae && (record?.buy_price?.ae as any) != 'NaN',
    );

    const result: HistoricalDataDto[] = [];
    let intervalStart = startDate.toDate().getTime();
    const endTimestamp = endDate.toDate().getTime();
    const intervalDuration = interval * 1000;

    let previousData: Transaction | undefined = initialPreviousData;
    let pointer = 0;

    while (intervalStart < endTimestamp) {
      const intervalEnd = intervalStart + intervalDuration;

      // Advance pointer past records before the current interval
      while (
        pointer < validData.length &&
        validData[pointer].created_at.getTime() < intervalStart
      ) {
        pointer++;
      }

      // Collect records within [intervalStart, intervalEnd)
      const intervalData: Transaction[] = [];
      let scan = pointer;
      while (
        scan < validData.length &&
        validData[scan].created_at.getTime() < intervalEnd
      ) {
        intervalData.push(validData[scan]);
        scan++;
      }

      if (intervalData.length) {
        const aggregatedData = this.aggregateIntervalData(
          intervalData,
          intervalStart,
          intervalEnd,
          props,
        );
        result.push(aggregatedData);
        previousData = this.advancedConvertAggregatedDataToTransaction(
          intervalData[intervalData.length - 1],
        );
      } else if (fillGaps && previousData) {
        result.push(
          this.aggregateIntervalData(
            [previousData],
            intervalStart,
            intervalEnd,
            props,
          ),
        );
      }

      intervalStart = intervalEnd;
    }

    return result.map((item, index) => {
      const previousItem = index > 0 ? result[index - 1] : null;
      if (previousItem) {
        item.quote.open = previousItem.quote.close;
      }
      return item;
    });
  }

  private aggregateIntervalData(
    intervalData: Transaction[],
    intervalStart: number,
    intervalEnd: number,
    props: IGetHistoricalDataProps,
  ): HistoricalDataDto {
    // console.log('aggregateIntervalData->intervalData::', intervalData);
    const open = intervalData[0];
    const close = intervalData[intervalData.length - 1];

    let high = open;
    let low = open;
    let volume = 0;
    let total_supply = new BigNumber(0);
    let market_cap = new BigNumber(0);

    intervalData.forEach((record) => {
      if (record.buy_price[props.convertTo] > high.buy_price[props.convertTo]) {
        high = record;
      }
      if (record.buy_price[props.convertTo] < low.buy_price[props.convertTo]) {
        low = record;
      }
      volume += record.volume?.toNumber() ?? 0;
      total_supply = record.total_supply;
      market_cap = record.market_cap[props.convertTo];
    });

    let open_buy_price: any = open.buy_price;

    if (open_buy_price?.ae == 'NaN') {
      if ((open?.previous_buy_price?.ae as any) != 'NaN') {
        open_buy_price = open.previous_buy_price;
      }
    }

    function getPrice(object: Transaction, convertTo, isOpenTrade = false) {
      let final_buy_price: any = object.buy_price;

      if (
        !!open?.previous_buy_price?.ae &&
        (final_buy_price?.ae == 'NaN' ||
          (object.tx_type === TX_FUNCTIONS.create_community && isOpenTrade))
      ) {
        final_buy_price = open.previous_buy_price;
      }

      // TODO: when no price is found the candle data should be excluded
      if (!final_buy_price) {
        return 0;
      }

      return final_buy_price[convertTo];
    }

    return {
      timeOpen: new Date(intervalStart),
      timeClose: new Date(intervalEnd - 1),
      timeHigh: high.created_at,
      timeLow: low.created_at,
      quote: {
        convertedTo: props.convertTo,
        open: getPrice(open, props.convertTo, true),
        high: getPrice(high, props.convertTo),
        low: getPrice(low, props.convertTo),
        close: getPrice(close, props.convertTo),
        volume: volume,
        market_cap,
        total_supply,
        timestamp: new Date(intervalEnd - 1),
        symbol: props.token.symbol,
      },
    };
  }

  private advancedConvertAggregatedDataToTransaction(
    aggregatedData: Transaction,
  ): Transaction {
    const tokenHistory = new Transaction();
    Object.keys(aggregatedData).forEach((key) => {
      tokenHistory[key] = aggregatedData[key];
    });
    // tokenHistory.price = { value: aggregatedData.quote.close } as any; // Ensure type compatibility
    // tokenHistory.sell_price = tokenHistory.price; // Adjust as per your entity structure
    // tokenHistory.market_cap = { value: aggregatedData.quote.market_cap } as any; // Ensure type compatibility
    // // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // // @ts-ignore
    // tokenHistory.total_supply = aggregatedData.quote.volume;
    // tokenHistory.created_at = aggregatedData.timeClose;
    return tokenHistory;
  }

  async getForPreview(
    token: Token,
    intervalType: '1d' | '7d' | '30d' | '90d' | '180d' | 'all-time',
  ): Promise<ITransactionPreview> {
    if (!token) return { result: [], timeframe: '' };

    if (intervalType === 'all-time') {
      return this.getForPreviewAllTime(token);
    }

    const types = {
      '1d': {
        interval: '20 minutes',
        unit: 'minute',
        size: 20,
        timeframe: '1 day',
        intervalMs: 20 * 60 * 1000,
      },
      '7d': {
        interval: '1 hour',
        unit: 'hour',
        size: 1,
        timeframe: '7 days',
        intervalMs: 60 * 60 * 1000,
      },
      '30d': {
        interval: '1 hours',
        unit: 'hour',
        size: 1,
        timeframe: '30 days',
        intervalMs: 60 * 60 * 1000,
      },
      '90d': {
        interval: '4 hours',
        unit: 'hour',
        size: 4,
        timeframe: '90 days',
        intervalMs: 4 * 60 * 60 * 1000,
      },
      '180d': {
        interval: '4 hours',
        unit: 'hour',
        size: 4,
        timeframe: '180 days',
        intervalMs: 4 * 60 * 60 * 1000,
      },
    };

    const { interval, unit, size, timeframe } = types[intervalType];

    const bucketExpr =
      size > 1
        ? `DATE_TRUNC('day', t.created_at) + INTERVAL '${size} ${unit}' * FLOOR(EXTRACT('${unit}' FROM t.created_at) / ${size})`
        : `DATE_TRUNC('${unit}', t.created_at)`;

    // Select the closing (latest) transaction price per bucket via DISTINCT ON
    const sparseData: Array<{ truncated_time: Date; last_price: number }> =
      await this.dataSource.query(
        `
        SELECT DISTINCT ON (bucket)
          bucket AS truncated_time,
          price AS last_price
        FROM (
          SELECT
            ${bucketExpr} AS bucket,
            t.created_at,
            CAST(t.buy_price->>'ae' AS FLOAT) AS price
          FROM transactions t
          WHERE t.sale_address = $1
            AND t.created_at >= NOW() - INTERVAL '${timeframe}'
            AND t.buy_price->>'ae' != 'NaN'
        ) sub
        ORDER BY bucket, created_at DESC
        `,
        [token.sale_address],
      );

    let result: ITransactionPreviewPrice[];

    if (sparseData.length <= 1) {
      const fallback: Array<{ truncated_time: Date; last_price: number }> =
        await this.dataSource.query(
          `
          SELECT
            t.created_at AS truncated_time,
            CAST(t.buy_price->>'ae' AS FLOAT) AS last_price
          FROM transactions t
          WHERE t.sale_address = $1
            AND t.buy_price->>'ae' != 'NaN'
          ORDER BY t.created_at DESC
          LIMIT 4
          `,
          [token.sale_address],
        );

      result = fallback.reverse().map((item) => ({
        last_price: String(item.last_price),
        end_time: item.truncated_time,
      }));
    } else {
      result = sparseData.map((item) => ({
        last_price: String(item.last_price),
        end_time: item.truncated_time,
      }));
    }

    if (token.created_at) {
      const timeframeDays = {
        '1d': 1,
        '7d': 7,
        '30d': 30,
        '90d': 90,
        '180d': 180,
      };
      const windowStart = Date.now() - timeframeDays[intervalType] * 86_400_000;
      const createdAt = new Date(token.created_at).getTime();

      if (createdAt >= windowStart && result.length > 0) {
        result.unshift({
          end_time: token.created_at,
          last_price: result[0].last_price,
        });
      }
    }

    return {
      result,
      count: result.length,
      timeframe,
      interval,
      token,
    } as ITransactionPreview;
  }

  /**
   * All-time preview: dynamically computes a bucket size targeting ~50 data
   * points across the token's full lifespan (min 1-hour buckets), then returns
   * only buckets that contain actual transactions — no gap-filling.
   */
  private async getForPreviewAllTime(
    token: Token,
  ): Promise<ITransactionPreview> {
    const sparseData: Array<{ truncated_time: Date; last_price: number }> =
      await this.dataSource.query(
        `
        WITH span AS (
          SELECT
            GREATEST(
              EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 50,
              3600
            ) AS bucket_secs
          FROM transactions
          WHERE sale_address = $1
            AND buy_price->>'ae' != 'NaN'
        ),
        bucketed AS (
          SELECT
            t.created_at,
            CAST(t.buy_price->>'ae' AS FLOAT) AS price,
            to_timestamp(
              FLOOR(EXTRACT(EPOCH FROM t.created_at) / s.bucket_secs) * s.bucket_secs
            ) AS bucket
          FROM transactions t, span s
          WHERE t.sale_address = $1
            AND t.buy_price->>'ae' != 'NaN'
        )
        SELECT DISTINCT ON (bucket)
          bucket AS truncated_time,
          price AS last_price
        FROM bucketed
        ORDER BY bucket, created_at DESC
        `,
        [token.sale_address],
      );

    let result: ITransactionPreviewPrice[];

    if (sparseData.length <= 1) {
      const fallback: Array<{ truncated_time: Date; last_price: number }> =
        await this.dataSource.query(
          `
          SELECT
            t.created_at AS truncated_time,
            CAST(t.buy_price->>'ae' AS FLOAT) AS last_price
          FROM transactions t
          WHERE t.sale_address = $1
            AND t.buy_price->>'ae' != 'NaN'
          ORDER BY t.created_at DESC
          LIMIT 4
          `,
          [token.sale_address],
        );

      result = fallback.reverse().map((item) => ({
        last_price: String(item.last_price),
        end_time: item.truncated_time,
      }));
    } else {
      result = sparseData.map((item) => ({
        last_price: String(item.last_price),
        end_time: item.truncated_time,
      }));
    }

    if (token.created_at && result.length > 0) {
      result.unshift({
        end_time: token.created_at,
        last_price: result[0].last_price,
      });
    }

    return {
      result,
      count: result.length,
      timeframe: 'all time',
      interval: 'dynamic',
      token,
    } as ITransactionPreview;
  }
}
