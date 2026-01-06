import BigNumber from 'bignumber.js';
import moment, { Moment } from 'moment';
import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { HistoricalDataDto } from '@/transactions/dto/historical-data.dto';
import { BclTransaction } from '../entities/bcl-transaction.entity';
import { BclToken } from '../entities/bcl-token.entity';

export interface IBclHistoricalToken {
  sale_address: string;
  symbol: string;
}

export interface IGetBclPaginatedHistoricalDataProps {
  token: IBclHistoricalToken;
  interval: number; // seconds
  page: number;
  limit: number;
  convertTo?: string;
}

export interface IGetBclHistoricalDataProps {
  token: IBclHistoricalToken;
  interval: number;
  startDate: Moment;
  endDate: Moment;
  convertTo?: string;
  mode: 'normal' | 'aggregated';
}

export interface ITransactionPreviewPrice {
  end_time: Date;
  last_price: string;
}

export interface ITransactionPreview {
  result: ITransactionPreviewPrice[];
  timeframe: string;
  count?: number;
  interval?: string;
  token?: any;
}

const ALLOWED_CONVERT_TO = new Set([
  'ae',
  'usd',
  'eur',
  'aud',
  'brl',
  'cad',
  'chf',
  'gbp',
  'xau',
]);

@Injectable()
export class BclTransactionHistoryService {
  constructor(
    @InjectRepository(BclTransaction)
    private readonly bclTransactionRepository: Repository<BclTransaction>,
    @InjectRepository(BclToken)
    private readonly bclTokenRepository: Repository<BclToken>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async getTokenByAddress(address: string): Promise<BclToken | null> {
    return await this.bclTokenRepository
      .createQueryBuilder('bcl_token')
      .where('bcl_token.sale_address = :address', { address })
      .orWhere('bcl_token.address = :address', { address })
      .orWhere('bcl_token.name = :address', { address })
      .orWhere('bcl_token.symbol = :address', { address })
      .getOne();
  }

  async getPaginatedHistoricalData(
    props: IGetBclPaginatedHistoricalDataProps,
  ): Promise<HistoricalDataDto[]> {
    const { token, interval, page, limit } = props;
    const convertToRaw = props.convertTo || 'ae';
    const convertTo = ALLOWED_CONVERT_TO.has(convertToRaw) ? convertToRaw : 'ae';

    const offset = (page - 1) * limit;
    const queryRunner = this.dataSource.createQueryRunner();

    // Important differences from `transactions` table:
    // - volume is varchar -> cast to numeric for aggregation
    // - total_supply is varchar -> cast to numeric for aggregation
    const rawResults = await queryRunner.query(
      `
        WITH transactions_in_intervals AS (
          SELECT 
            t.created_at,
            CAST(NULLIF(t.buy_price->>'${convertTo}', 'NaN') AS decimal) as price,
            COALESCE(NULLIF(t.volume, ''), '0')::numeric as volume,
            CAST(COALESCE(NULLIF(t.market_cap->>'${convertTo}', 'NaN'), '0') AS decimal) as market_cap,
            COALESCE(NULLIF(t.total_supply, ''), '0')::numeric as total_supply,
            to_timestamp(
              floor(extract(epoch from t.created_at) / $2) * $2
            ) as interval_start
          FROM bcl_transactions t
          WHERE t.sale_address = $1
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
      `,
      [token.sale_address, interval],
    );

    await queryRunner.release();

    let lastClose: string | null = null;
    return rawResults.map((row: any) => {
      const result: any = {
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
    props: IGetBclHistoricalDataProps,
  ): Promise<HistoricalDataDto[]> {
    const convertToRaw = props.convertTo || 'ae';
    const convertTo = ALLOWED_CONVERT_TO.has(convertToRaw) ? convertToRaw : 'ae';
    const { startDate, endDate } = props;

    const data = await this.bclTransactionRepository
      .createQueryBuilder('bcl_transactions')
      .where('bcl_transactions.sale_address = :sale_address', {
        sale_address: props.token.sale_address,
      })
      .andWhere('bcl_transactions.created_at >= :start', {
        start: startDate.toDate(),
      })
      .andWhere('bcl_transactions.created_at <= :endDate', {
        endDate: endDate.toDate(),
      })
      .orderBy('bcl_transactions.created_at', 'ASC')
      .getMany();

    const firstBefore =
      props.mode === 'aggregated'
        ? await this.bclTransactionRepository
            .createQueryBuilder('bcl_transactions')
            .where('bcl_transactions.sale_address = :sale_address', {
              sale_address: props.token.sale_address,
            })
            .andWhere('bcl_transactions.created_at < :start', {
              start: startDate.toDate(),
            })
            .orderBy('bcl_transactions.created_at', 'DESC')
            .limit(1)
            .getOne()
        : undefined;

    return this.processAggregatedHistoricalData(
      data,
      {
        ...props,
        convertTo,
      },
      firstBefore,
      props.mode === 'aggregated',
    );
  }

  private processAggregatedHistoricalData(
    data: BclTransaction[],
    props: IGetBclHistoricalDataProps & { convertTo: string },
    initialPreviousData: BclTransaction | undefined = undefined,
    fillGaps: boolean,
  ): HistoricalDataDto[] {
    const { startDate, endDate, interval, convertTo } = props;

    const result: HistoricalDataDto[] = [];
    let intervalStart = startDate.toDate().getTime();
    const endTimestamp = endDate.toDate().getTime();
    const intervalDuration = interval * 1000;

    let previousData: BclTransaction | undefined = initialPreviousData;

    while (intervalStart < endTimestamp) {
      const intervalEnd = intervalStart + intervalDuration;
      const intervalData = data.filter((record) => {
        const price = record?.buy_price?.[convertTo];
        if (price === undefined || price === null || price === 'NaN') {
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
        previousData = this.cloneAsPrevious(intervalData[intervalData.length - 1]);
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
        (item as any).quote.open = (previousItem as any).quote.close;
      }
      return item;
    });
  }

  private aggregateIntervalData(
    intervalData: BclTransaction[],
    intervalStart: number,
    intervalEnd: number,
    props: IGetBclHistoricalDataProps & { convertTo: string },
  ): HistoricalDataDto {
    const { convertTo } = props;

    const open = intervalData[0];
    const close = intervalData[intervalData.length - 1];

    let high = open;
    let low = open;
    let volume = 0;
    let total_supply = new BigNumber(0);
    let market_cap = new BigNumber(0);

    const getNumeric = (v: any) => {
      if (v === null || v === undefined || v === 'NaN') return 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    intervalData.forEach((record) => {
      if (getNumeric(record?.buy_price?.[convertTo]) > getNumeric(high?.buy_price?.[convertTo])) {
        high = record;
      }
      if (getNumeric(record?.buy_price?.[convertTo]) < getNumeric(low?.buy_price?.[convertTo])) {
        low = record;
      }
      volume += parseFloat(record.volume || '0') || 0;
      total_supply = new BigNumber(record.total_supply || '0');
      market_cap = new BigNumber(record?.market_cap?.[convertTo] ?? 0);
    });

    let open_buy_price: any = open.buy_price;
    if (open_buy_price?.[convertTo] === 'NaN') {
      if (open?.previous_buy_price?.[convertTo] !== 'NaN') {
        open_buy_price = open.previous_buy_price;
      }
    }

    const getPrice = (object: BclTransaction) => {
      let final_buy_price: any = object.buy_price;
      if (
        !!open?.previous_buy_price?.[convertTo] &&
        (final_buy_price?.[convertTo] === 'NaN' || object.tx_type === 'create_community')
      ) {
        final_buy_price = open.previous_buy_price;
      }
      if (!final_buy_price) return 0;
      return getNumeric(final_buy_price[convertTo]);
    };

    return {
      timeOpen: new Date(intervalStart),
      timeClose: new Date(intervalEnd - 1),
      timeHigh: high.created_at,
      timeLow: low.created_at,
      quote: {
        convertedTo: convertTo,
        open: getNumeric(open_buy_price?.[convertTo]),
        high: getPrice(high),
        low: getPrice(low),
        close: getPrice(close),
        volume,
        market_cap,
        total_supply,
        timestamp: new Date(intervalEnd - 1),
        symbol: props.token.symbol,
      } as any,
    };
  }

  private cloneAsPrevious(tx: BclTransaction): BclTransaction {
    const copy: any = new BclTransaction();
    Object.keys(tx as any).forEach((key) => {
      copy[key] = (tx as any)[key];
    });
    return copy;
  }

  async getForPreview(token: IBclHistoricalToken, intervalType: '1d' | '7d' | '30d') {
    if (!token) return { result: [], timeframe: '' };
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
    const { interval, unit, size, timeframe } = types[intervalType];

    const truncationQuery =
      size > 1
        ? `DATE_TRUNC('${unit}', bcl_transactions.created_at) + INTERVAL '${size} ${unit}' * FLOOR(EXTRACT('${unit}' FROM bcl_transactions.created_at) / ${size})`
        : `DATE_TRUNC('${unit}', bcl_transactions.created_at)`;

    const data = await this.bclTransactionRepository
      .createQueryBuilder('bcl_transactions')
      .select([
        `${truncationQuery} AS truncated_time`,
        "MAX(CAST(bcl_transactions.buy_price->>'ae' AS FLOAT)) AS max_buy_price",
      ])
      .where('bcl_transactions.sale_address = :sale_address', {
        sale_address: token.sale_address,
      })
      .andWhere(`bcl_transactions.created_at >= NOW() - INTERVAL '${timeframe}'`)
      .andWhere(`bcl_transactions.buy_price->>'ae' != 'NaN'`)
      .groupBy('truncated_time')
      .orderBy('truncated_time', 'DESC')
      .getRawMany();

    let result: any[];
    if (data.length <= 1) {
      const latestTransactions = await this.bclTransactionRepository
        .createQueryBuilder('bcl_transactions')
        .select([
          'bcl_transactions.created_at as truncated_time',
          "CAST(bcl_transactions.buy_price->>'ae' AS FLOAT) as max_buy_price",
        ])
        .where('bcl_transactions.sale_address = :sale_address', {
          sale_address: token.sale_address,
        })
        .andWhere(`bcl_transactions.buy_price->>'ae' != 'NaN'`)
        .orderBy('bcl_transactions.created_at', 'DESC')
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

    result = result.filter(
      (item, index) =>
        index ===
        result.findIndex((t) =>
          moment(t.end_time).isSame(moment(item.end_time)),
        ),
    );

    return {
      result,
      count: result.length,
      timeframe,
      interval,
      token,
    } as ITransactionPreview;
  }
}


