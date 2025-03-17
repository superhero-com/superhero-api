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
    const pgInterval = `${interval} seconds`;
    const offset = (page - 1) * limit;

    const queryRunner = this.dataSource.createQueryRunner();
    const rawResults = await queryRunner
      .query(`
        WITH bounded_transactions AS (
          SELECT 
            created_at,
            buy_price->>'${convertTo}' as price,
            volume,
            market_cap->>'${convertTo}' as market_cap,
            total_supply
          FROM transactions
          WHERE "tokenId" = $1
            AND buy_price->>'${convertTo}' != 'NaN'
          ORDER BY created_at DESC
          OFFSET ${offset}
          LIMIT ${limit * 2}  -- Fetch extra record for previous close price
        ),
        time_groups AS (
          SELECT 
            date_trunc('second', created_at) - 
              (EXTRACT(EPOCH FROM created_at)::integer % $2) * INTERVAL '1 second' as interval_start,
            price::float,
            created_at,
            volume,
            market_cap,
            total_supply
          FROM bounded_transactions
        ),
        aggregated AS (
          SELECT 
            interval_start,
            MIN(price) AS low,
            MAX(price) AS high,
            SUM(COALESCE(volume, 0)) AS volume,
            MAX(market_cap) AS market_cap,
            MAX(total_supply) AS total_supply,
            MIN(created_at) AS "timeMin",
            MAX(created_at) AS "timeMax",
            LAST_VALUE(price) OVER (
              PARTITION BY interval_start 
              ORDER BY created_at
              ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
            ) as close
          FROM time_groups
          GROUP BY interval_start, created_at, price
        ),
        final_aggregated AS (
          SELECT 
            a.*,
            LAG(close) OVER (ORDER BY interval_start DESC) as open
          FROM (
            SELECT DISTINCT ON (interval_start)
            interval_start,
            low,
            high,
            volume,
            market_cap,
            total_supply,
            "timeMin",
            "timeMax",
            close
            FROM aggregated
          ) a
        )
        SELECT 
          interval_start AS "timeOpen",
          interval_start + INTERVAL '${pgInterval}' AS "timeClose",
          low,
          high,
          COALESCE(open, close) as open,
          close,
          volume,
          market_cap,
          total_supply,
          "timeMin",
          "timeMax"
        FROM final_aggregated
        ORDER BY interval_start DESC
        LIMIT ${limit}
      `, [token.id, interval]);

    await queryRunner.release();
    
    return rawResults.map((row) => ({
      timeOpen: row.timeOpen,
      timeClose: row.timeClose,
      timeHigh: row.timeMax,
      timeLow: row.timeMin,
      quote: {
        convertedTo: convertTo,
        open: parseFloat(row.open || '0'),
        high: parseFloat(row.high || '0'),
        low: parseFloat(row.low || '0'),
        close: parseFloat(row.close || '0'),
        volume: parseFloat(row.volume || '0'),
        market_cap: new BigNumber(row.market_cap || '0'),
        total_supply: new BigNumber(row.total_supply || '0'),
        timestamp: row.timeClose,
        symbol: token.symbol,
      },
    }));
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

  async getForPreview(token: Token | null) {
    if (!token) return { result: [], timeframe: '' };
    const getIntervalTimeFrame = () => {
      const daysDiff = moment()
        .add(1, 'day')
        .diff(moment(token.created_at), 'days');

      if (daysDiff > 7) {
        return {
          interval: '1 day',
          unit: 'day',
          size: 1,
          timeframe: '30 days',
        };
      } else if (daysDiff > 1) {
        return {
          interval: '6 hours',
          unit: 'hour',
          size: 6,
          timeframe: '7 days',
        };
      } else {
        return {
          interval: '20 minutes',
          unit: 'minute',
          size: 20,
          timeframe: '1 day',
        };
      }
    };

    const { interval, unit, size, timeframe } = getIntervalTimeFrame();

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

    const result = data.map((item) => ({
      last_price: item.max_buy_price, // Ensure it's parsed correctly
      end_time: item.truncated_time, // Grouped time
    }));

    return {
      result,
      count: result.length,
      timeframe,
      interval,
      token,
    } as ITransactionPreview;
  }
}
