import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import { Moment } from 'moment';
import { Repository } from 'typeorm';
import { HistoricalDataDto } from './dto/historical-data.dto';
import { TokenHistory } from './entities/token-history.entity';
import { Token } from './entities/token.entity';
import moment from 'moment';

export interface IGetHistoricalDataProps {
  token: Token;
  interval: number;
  startDate: Moment;
  endDate: Moment;
  convertTo?: string;
  mode: 'normal' | 'aggregated';
}

@Injectable()
export class TokenHistoryService {
  constructor(
    @InjectRepository(TokenHistory)
    private readonly tokenHistoryRepository: Repository<TokenHistory>,
  ) {}

  async getHistoricalData(
    props: IGetHistoricalDataProps,
  ): Promise<HistoricalDataDto[]> {
    const { startDate, endDate } = props;
    console.log('startDate', startDate.toDate());
    const data = await this.tokenHistoryRepository
      .createQueryBuilder('token_history')
      .where('token_history.tokenId = :tokenId', {
        tokenId: props.token.id,
      })
      // .andWhere('token_history.created_at >= :start', {
      //   start: startDate.toDate(),
      // })
      .andWhere('token_history.created_at <= :end', { end: endDate.toDate() })
      .orderBy('token_history.created_at', 'ASC')
      .getMany();

    console.log('props.aggregated', props.mode);
    return props.mode === 'aggregated'
      ? this.processAggregatedHistoricalData(data, props)
      : this.processNonAggregatedHistoricalData(data, props);
  }

  private processNonAggregatedHistoricalData(
    data: TokenHistory[],
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
        item.price_data[props.convertTo] > acc.price_data[props.convertTo]
          ? item
          : acc,
      );
      const low = items.reduce((acc, item) =>
        item.price_data[props.convertTo] < acc.price_data[props.convertTo]
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
          open: open.price_data[props.convertTo],
          high: high.price_data[props.convertTo],
          low: low.price_data[props.convertTo],
          close: close.price_data[props.convertTo],
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
    data: TokenHistory[],
    props: IGetHistoricalDataProps,
  ): HistoricalDataDto[] {
    const { startDate, endDate, interval } = props;

    const result: HistoricalDataDto[] = [];
    let intervalStart = startDate.toDate().getTime();
    const endTimestamp = endDate.toDate().getTime();
    const intervalDuration = interval * 1000;
    // const intervalDuration = this.getIntervalDuration(interval);

    let previousData: TokenHistory | null = null;

    while (intervalStart < endTimestamp) {
      const intervalEnd = intervalStart + intervalDuration;
      const intervalData = data.filter((record) => {
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
        previousData = this.advancedConvertAggregatedDataToTokenHistory(
          intervalData[intervalData.length - 1],
        );
      } else if (previousData) {
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
    intervalData: TokenHistory[],
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
      if (
        record.price_data[props.convertTo] > high.price_data[props.convertTo]
      ) {
        high = record;
      }
      if (
        record.price_data[props.convertTo] < low.price_data[props.convertTo]
      ) {
        low = record;
      }
      volume = intervalData
        .map((item) => item.volume?.toNumber())
        .reduce((a, b) => a + b);
      // volume = record?.volume?.toNumber() ?? 0;
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      total_supply = record.total_supply;
      market_cap = record.market_cap_data
        ? record.market_cap_data[props.convertTo]
        : record.market_cap;
    });

    return {
      timeOpen: new Date(intervalStart),
      timeClose: new Date(intervalEnd - 1),
      timeHigh: high.created_at,
      timeLow: low.created_at,
      quote: {
        convertedTo: props.convertTo,
        open: open.price_data[props.convertTo],
        high: high.price_data[props.convertTo],
        low: low.price_data[props.convertTo],
        close: close.price_data[props.convertTo],
        volume: volume,
        market_cap,
        total_supply,
        timestamp: new Date(intervalEnd - 1),
        symbol: props.token.symbol,
      },
    };
  }

  private convertAggregatedDataToTokenHistory(
    aggregatedData: HistoricalDataDto,
  ): TokenHistory {
    const tokenHistory = new TokenHistory();
    tokenHistory.price = { value: aggregatedData.quote.close } as any; // Ensure type compatibility
    tokenHistory.sell_price = tokenHistory.price; // Adjust as per your entity structure
    tokenHistory.market_cap = { value: aggregatedData.quote.market_cap } as any; // Ensure type compatibility
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    tokenHistory.total_supply = aggregatedData.quote.volume;
    tokenHistory.created_at = aggregatedData.timeClose;
    return tokenHistory;
  }
  private advancedConvertAggregatedDataToTokenHistory(
    aggregatedData: TokenHistory,
  ): TokenHistory {
    const tokenHistory = new TokenHistory();
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
}
