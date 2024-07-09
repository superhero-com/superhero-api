import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import { Moment } from 'moment';
import { Repository } from 'typeorm';
import { HistoricalDataDto } from './dto/historical-data.dto';
import { TokenHistory } from './entities/token-history.entity';
import { Token } from './entities/token.entity';

export interface IGetHistoricalDataProps {
  token: Token;
  interval: number;
  startDate: Moment;
  endDate: Moment;
  convertTo?: string;
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
      // .where('token_history.created_at >= :start', {
      //   start: startDate.toDate(),
      // })
      // .where('token_history.created_at <= :end', { end: endDate.toDate() })
      .orderBy('token_history.created_at', 'ASC')
      .getMany();

    return this.processHistoricalData(data, props);
  }

  private getIntervalDuration(interval: string): number {
    switch (interval) {
      case '1m':
        return 60 * 1000;
      case '5m':
        return 5 * 60 * 1000;
      case '15m':
        return 15 * 60 * 1000;
      case '1h':
        return 60 * 60 * 1000;
      case '4h':
        return 4 * 60 * 60 * 1000;
      case '1d':
        return 24 * 60 * 60 * 1000;
      case '7d':
        return 7 * 24 * 60 * 60 * 1000;
      case '30d':
        return 30 * 24 * 60 * 60 * 1000;
      default:
        throw new Error('Invalid interval');
    }
  }

  private processHistoricalData(
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
