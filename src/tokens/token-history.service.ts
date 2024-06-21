import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TokenHistory } from './entities/token-history.entity';
import { HistoricalDataDto, QuoteDto } from './dto/historical-data.dto';
import { Moment } from 'moment';
import BigNumber from 'bignumber.js';

export interface IGetHistoricalDataProps {
  address: string;
  interval: string;
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
    const { interval, startDate } = props;
    const data = await this.tokenHistoryRepository
      .createQueryBuilder('token_history')
      .where('token_history.sale_address = :address', {
        address: props.address,
      })
      // .where('token_history.created_at >= :start', {
      //   start: start.toISOString(),
      // })
      // .andWhere('token_history.created_at <= :end', { end: end.toISOString() })
      .orderBy('token_history.created_at', 'ASC')
      .getMany();

    return this.processHistoricalData(data, props);
  }

  private getIntervalDuration(interval: string): number {
    switch (interval) {
      case '1m':
        return 60 * 1000;
      case '1h':
        return 60 * 60 * 1000;
      case '3h':
        return 3 * 60 * 60 * 1000;
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
    const intervalDuration = this.getIntervalDuration(interval);

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
        // previousData = this.convertAggregatedDataToTokenHistory(aggregatedData);
      } else if (previousData) {
        result.push(
          this.createForwardFilledInterval(
            previousData,
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

    return result;
  }

  private aggregateIntervalData(
    intervalData: TokenHistory[],
    intervalStart: number,
    intervalEnd: number,
    props: IGetHistoricalDataProps,
  ): HistoricalDataDto {
    const open = intervalData[0];
    const close = intervalData[intervalData.length - 1];

    let high = open;
    let low = open;
    let volume = 0;
    let total_supply = new BigNumber(0);
    let market_cap = new BigNumber(0);

    intervalData.forEach((record) => {
      if (record.price[props.convertTo] > high.price[props.convertTo]) {
        high = record;
      }
      if (record.price[props.convertTo] < low.price[props.convertTo]) {
        low = record;
      }
      volume = 0;
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      total_supply = record.total_supply;
      market_cap = record.market_cap[props.convertTo];
    });

    return {
      timeOpen: new Date(intervalStart),
      timeClose: new Date(intervalEnd - 1),
      timeHigh: high.created_at,
      timeLow: low.created_at,
      quote: {
        convertedTo: props.convertTo,
        open: open.price[props.convertTo],
        high: high.price[props.convertTo],
        low: low.price[props.convertTo],
        close: close.price[props.convertTo],
        volume: volume,
        market_cap,
        total_supply,
        timestamp: new Date(intervalEnd - 1),
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

  private createForwardFilledInterval(
    previousData: TokenHistory,
    intervalStart: number,
    intervalEnd: number,
    props: IGetHistoricalDataProps,
  ): HistoricalDataDto {
    return {
      timeOpen: new Date(intervalStart),
      timeClose: new Date(intervalEnd - 1),
      timeHigh: previousData.created_at,
      timeLow: previousData.created_at,
      quote: {
        convertedTo: props.convertTo,
        open: previousData.price[props.convertTo],
        high: previousData.price[props.convertTo],
        low: previousData.price[props.convertTo],
        close: previousData.price[props.convertTo],
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        volume: previousData.total_supply,
        total_supply: previousData.total_supply,
        market_cap: previousData.market_cap[props.convertTo],
        timestamp: new Date(intervalEnd - 1),
      },
    };
  }
}
