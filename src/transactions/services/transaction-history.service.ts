import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import moment, { Moment } from 'moment';
import { TX_FUNCTIONS } from '@/configs';
import { Token } from '@/tokens/entities/token.entity';
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

@Injectable()
export class TransactionHistoryService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) { }

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
    const { token, interval, page, limit, convertTo = 'ae' } = props;
    const offset = (page - 1) * limit;

    const queryRunner = this.dataSource.createQueryRunner();
    //"MAX(CAST(transactions.buy_price->>'ae' AS FLOAT)) AS max_buy_price",
    const rawResults = await queryRunner
      .query(`
        WITH transactions_in_intervals AS (
          SELECT 
            t.created_at,
            CAST(NULLIF(t.buy_price->>'${convertTo}', 'NaN') AS decimal) as price,
            t.volume,
            (t.market_cap->>'${convertTo}') as market_cap,
            t.total_supply,
            to_timestamp(
              floor(extract(epoch from t.created_at) / $2) * $2
            ) as interval_start
          FROM transactions t
          WHERE t."tokenId" = $1
            AND t.buy_price->>'${convertTo}' != 'NaN'
        ),
        grouped_intervals AS (
          SELECT DISTINCT interval_start
          FROM transactions_in_intervals
          ORDER BY interval_start DESC
          OFFSET ${offset}
          LIMIT ${limit}
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
          interval_start + (interval '$2 seconds') as "timeClose",
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
      `, [token.id, interval]);

    await queryRunner.release();

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

  async getHistoricalData(
    props: IGetHistoricalDataProps,
  ): Promise<HistoricalDataDto[]> {
    const { startDate, endDate } = props;

    const data = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .where('transactions."tokenId" = :tokenId', {
        tokenId: props.token.id,
      })
      .andWhere('transactions.created_at >= :start', {
        start: startDate.toDate(),
      })
      .andWhere('transactions.created_at <= :endDate', {
        endDate: endDate.toDate(),
      })
      .orderBy('transactions.created_at', 'ASC')
      .getMany();

    const firstBefore =
      props.mode === 'aggregated'
        ? await this.transactionsRepository
          .createQueryBuilder('transactions')
          .where('transactions."tokenId" = :tokenId', {
            tokenId: props.token.id,
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

    const result: HistoricalDataDto[] = [];
    let intervalStart = startDate.toDate().getTime();
    const endTimestamp = endDate.toDate().getTime();
    const intervalDuration = interval * 1000;
    // const intervalDuration = this.getIntervalDuration(interval);

    let previousData: Transaction | undefined = initialPreviousData;

    while (intervalStart < endTimestamp) {
      const intervalEnd = intervalStart + intervalDuration;
      const intervalData = data.filter((record) => {
        if (!record?.buy_price?.ae || (record?.buy_price?.ae as any) == 'NaN') {
          return false;
        }
        const recordTime = record.created_at.getTime();
        return recordTime >= intervalStart && recordTime < intervalEnd;
      });

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
      } else {
        // Handle the case where there's no previous data and no interval data.
        // For example, set a default value or continue.
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
    // return result;
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

  async getForPreview(token: Token, intervalType: '1d' | '7d' | '30d') {
    if (!token) return { result: [], timeframe: '' };
    const types = {
      '1d': {
        interval: '20 minutes',
        unit: 'minute',
        size: 20,
        timeframe: '1 day',
      },
      '7d': {
        interval: '6 hours',
        unit: 'hour',
        size: 6,
        timeframe: '7 days',
      },
      '30d': {
        interval: '1 day',
        unit: 'day',
        size: 1,
        timeframe: '30 days',
      },
    };
    const { interval, unit, size, timeframe } = types[intervalType];

    // Create dynamic truncation based on the interval unit and size
    const truncationQuery =
      size > 1
        ? `DATE_TRUNC('${unit}', transactions.created_at) + INTERVAL '${size} ${unit}' * FLOOR(EXTRACT('${unit}' FROM transactions.created_at) / ${size})`
        : `DATE_TRUNC('${unit}', transactions.created_at)`; // For single units like '1 day'

    const data = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .where('')
      .select([
        `${truncationQuery} AS truncated_time`,
        "MAX(CAST(transactions.buy_price->>'ae' AS FLOAT)) AS max_buy_price",
      ])
      .where('transactions."tokenId" = :tokenId', {
        tokenId: token.id,
      })
      .andWhere(`transactions.created_at >= NOW() - INTERVAL '${timeframe}'`)
      .andWhere(`transactions.buy_price->>'ae' != 'NaN'`) // Exclude NaN values
      .groupBy('truncated_time')
      .orderBy('truncated_time', 'DESC')
      .getRawMany();

    let result;
    if (data.length === 0) {
      // If no transactions found for interval, get latest 4 transactions
      const latestTransactions = await this.transactionsRepository
        .createQueryBuilder('transactions')
        .select([
          'transactions.created_at as truncated_time',
          "CAST(transactions.buy_price->>'ae' AS FLOAT) as max_buy_price",
        ])
        .where('transactions."tokenId" = :tokenId', {
          tokenId: token.id,
        })
        .andWhere(`transactions.buy_price->>'ae' != 'NaN'`)
        .orderBy('transactions.created_at', 'DESC')
        .limit(4)
        .getRawMany();

      result = latestTransactions.map((item) => ({
        last_price: item.max_buy_price,
        end_time: item.truncated_time,
      }));
    } else {
      result = data.map((item) => ({
        last_price: item.max_buy_price,
        end_time: item.truncated_time,
      }));
    }

    return {
      result,
      count: result.length,
      timeframe,
      interval,
      token,
    } as ITransactionPreview;
  }
}
