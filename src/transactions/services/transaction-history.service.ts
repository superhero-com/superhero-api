import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import moment, { Moment } from 'moment';
import { TX_FUNCTIONS } from '@/configs';
import { Token } from '@/tokens/entities/token.entity';
import { DataSource, Repository } from 'typeorm';
import { HistoricalDataDto } from '../dto/historical-data.dto';
import { Transaction } from '../entities/transaction.entity';

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

  async getHistoricalData(
    props: IGetHistoricalDataProps,
  ): Promise<HistoricalDataDto[]> {
    const { startDate, endDate } = props;

    const data = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .where('transactions.tokenId = :tokenId', {
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
            .where('transactions.tokenId = :tokenId', {
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

  /**
   * @deprecated
   */
  private processNonAggregatedHistoricalData(
    data: Transaction[],
    props: IGetHistoricalDataProps,
  ): HistoricalDataDto[] {
    // group data by date
    const groupedData = data.reduce((acc, item) => {
      const date = moment(item.created_at).format('YYYY-MM-DD HH:mm');
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(item);
      return acc;
    }, {});

    // convert to HistoricalDataDto
    const result = Object.keys(groupedData).map((date) => {
      const items = groupedData[date].sort((a, b) => {
        return a.created_at.getTime() - b.created_at.getTime();
      });
      const open = items[0];
      const close = items[items.length - 1];
      const high = items.reduce((acc, item) =>
        item.buy_price[props.convertTo] > acc.buy_price[props.convertTo]
          ? item
          : acc,
      );
      const low = items.reduce((acc, item) =>
        item.buy_price[props.convertTo] < acc.buy_price[props.convertTo]
          ? item
          : acc,
      );
      const volume = items.reduce(
        (acc, item) => acc + item.volume?.toNumber(),
        0,
      );
      const market_cap = items.reduce(
        (acc, item) =>
          acc +
          (item.market_cap_data
            ? item.market_cap_data[props.convertTo]
            : item.market_cap?.toNumber()),
        0,
      );
      const total_supply = items.reduce(
        (acc, item) => acc + item.total_supply,
        0,
      );

      return {
        timeOpen: open.created_at,
        timeClose: close.created_at,
        timeHigh: high.created_at,
        timeLow: low.created_at,
        quote: {
          convertedTo: props.convertTo,
          open: open.buy_price[props.convertTo],
          high: high.buy_price[props.convertTo],
          low: low.buy_price[props.convertTo],
          close: close.buy_price[props.convertTo],
          volume,
          market_cap,
          total_supply,
          timestamp: close.created_at,
          symbol: props.token.symbol,
        },
      };
    });

    return result.map((item, index) => {
      const previousItem = index > 0 ? result[index - 1] : null;
      if (previousItem) {
        item.quote.open = previousItem.quote.close;
      }
      return item;
    });
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

  async getForPreview(oldestHistoryInfo: IOldestHistoryInfo | null) {
    if (!oldestHistoryInfo) return { result: [], timeframe: '' };
    const getIntervalTimeFrame = () => {
      const daysDiff = moment()
        .add(1, 'day')
        .diff(moment(oldestHistoryInfo.created_at), 'days');
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
      .where('transactions.tokenId = :tokenId', {
        tokenId: oldestHistoryInfo.id,
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
      timeframe,
      interval,
    } as ITransactionPreview;
  }
}
