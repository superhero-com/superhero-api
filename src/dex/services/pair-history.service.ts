import { AeSdkService } from '@/ae/ae-sdk.service';
import { Encoded } from '@aeternity/aepp-sdk';
import ContractWithMethods, {
  ContractMethodsBase,
} from '@aeternity/aepp-sdk/es/contract/Contract';
import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Pair } from '../entities/pair.entity';
import BigNumber from 'bignumber.js';
import moment, { Moment } from 'moment';
import { DataSource, Repository } from 'typeorm';
import { HistoricalDataDto } from '@/transactions/dto/historical-data.dto';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { PairSummaryDto } from '../dto/pair-summary.dto';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';

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
  contracts: Record<
    Encoded.ContractAddress,
    ContractWithMethods<ContractMethodsBase>
  > = {};
  constructor(
    @InjectRepository(Pair)
    private readonly pairRepository: Repository<Pair>,

    private aeSdkService: AeSdkService,

    @InjectDataSource() private readonly dataSource: DataSource,

    private aePricingService: AePricingService,
  ) {
    //
  }

  async getPaginatedHistoricalData(
    props: IGetPaginatedHistoricalDataProps,
  ): Promise<HistoricalDataDto[]> {
    const { fromToken, pair, interval, page, limit, convertTo = 'ae' } = props;
    const offset = (page - 1) * limit;

    const queryRunner = this.dataSource.createQueryRunner();
    //"MAX(CAST(transactions.buy_price->>'ae' AS FLOAT)) AS max_buy_price",
    const value = fromToken === 'token0' ? '0' : '1';
    const rawResults = await queryRunner.query(
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
      [pair.address, interval],
    );

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
          symbol: pair.token0.symbol,
        },
      };
      lastClose = String(row.close || '0');
      return result;
    });
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

  // async getForPreview(token: Token, intervalType: '1d' | '7d' | '30d') {
  //   if (!token) return { result: [], timeframe: '' };
  //   const types = {
  //     '1d': {
  //       interval: '20 minutes',
  //       unit: 'minute',
  //       size: 20,
  //       timeframe: '1 day',
  //     },
  //     '7d': {
  //       interval: '1 hour',
  //       unit: 'hour',
  //       size: 1,
  //       timeframe: '7 days',
  //     },
  //     '30d': {
  //       interval: '4 hours',
  //       unit: 'hour',
  //       size: 4,
  //       timeframe: '30 days',
  //     },
  //   };
  //   const { interval, unit, size, timeframe } = types[intervalType];

  //   // Create dynamic truncation based on the interval unit and size
  //   const truncationQuery =
  //     size > 1
  //       ? `DATE_TRUNC('${unit}', transactions.created_at) + INTERVAL '${size} ${unit}' * FLOOR(EXTRACT('${unit}' FROM transactions.created_at) / ${size})`
  //       : `DATE_TRUNC('${unit}', transactions.created_at)`; // For single units like '1 day'

  //   const data = await this.transactionsRepository
  //     .createQueryBuilder('transactions')
  //     .where('')
  //     .select([
  //       `${truncationQuery} AS truncated_time`,
  //       "MAX(CAST(transactions.buy_price->>'ae' AS FLOAT)) AS max_buy_price",
  //     ])
  //     .where('transactions.sale_address = :sale_address', {
  //       sale_address: token.sale_address,
  //     })
  //     .andWhere(`transactions.created_at >= NOW() - INTERVAL '${timeframe}'`)
  //     .andWhere(`transactions.buy_price->>'ae' != 'NaN'`) // Exclude NaN values
  //     .groupBy('truncated_time')
  //     .orderBy('truncated_time', 'DESC')
  //     .getRawMany();

  //   let result;
  //   if (data.length <= 1) {
  //     // If no transactions found for interval, get latest 4 transactions
  //     const latestTransactions = await this.transactionsRepository
  //       .createQueryBuilder('transactions')
  //       .select([
  //         'transactions.created_at as truncated_time',
  //         "CAST(transactions.buy_price->>'ae' AS FLOAT) as max_buy_price",
  //       ])
  //       .where('transactions.sale_address = :sale_address', {
  //         sale_address: token.sale_address,
  //       })
  //       .andWhere(`transactions.buy_price->>'ae' != 'NaN'`)
  //       .orderBy('transactions.created_at', 'DESC')
  //       .limit(4)
  //       .getRawMany();

  //     result = latestTransactions.map((item) => ({
  //       last_price: item.max_buy_price,
  //       end_time: item.truncated_time,
  //     }));
  //   } else {
  //     result = data.map((item) => ({
  //       last_price: item.max_buy_price,
  //       end_time: item.truncated_time,
  //     }));
  //   }

  //   // prevent duplicate with same end_time
  //   result = result.filter(
  //     (item, index) =>
  //       index ==
  //       result.findIndex((t) =>
  //         moment(t.end_time).isSame(moment(item.end_time)),
  //       ),
  //   );

  //   return {
  //     result,
  //     count: result.length,
  //     timeframe,
  //     interval,
  //     token,
  //   } as ITransactionPreview;
  // }

  async getPairSummary(pair: Pair, token?: string): Promise<PairSummaryDto> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      // Determine which token to use for volume calculations
      let volumeToken = '0'; // Default to token0
      let isToken0WAE = false;
      let isToken1WAE = false;

      // Check if token0 or token1 is WAE
      if (pair.token0?.address === DEX_CONTRACTS.wae) {
        isToken0WAE = true;
      }
      if (pair.token1?.address === DEX_CONTRACTS.wae) {
        isToken1WAE = true;
      }

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
      // Get total volume for the selected token
      const volumeResult = await queryRunner.query(
        `
          SELECT 
            COALESCE(SUM(volume${volumeToken}), 0) as total_volume
          FROM pair_transactions 
          WHERE pair_address = $1
        `,
        [pair.address],
      );

      // Get current reserves for locked value
      const reservesResult = await queryRunner.query(
        `
          SELECT 
            reserve0,
            reserve1,
            ratio0,
            ratio1
          FROM pairs 
          WHERE address = $1
        `,
        [pair.address],
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
        // Get volume for the period
        const periodVolumeResult = await queryRunner.query(
          `
            SELECT 
              COALESCE(SUM(volume${volumeToken}), 0) as total_volume
            FROM pair_transactions 
            WHERE pair_address = $1 AND created_at >= $2
          `,
          [pair.address, startDate.toDate()],
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
          const startPrice = new BigNumber(priceData.start_price);
          const currentPrice = new BigNumber(priceData.current_price);
          const changeValue = currentPrice.minus(startPrice);
          const changePercentage = startPrice.isZero()
            ? 0
            : changeValue.dividedBy(startPrice).multipliedBy(100);

          priceChange = {
            percentage: changePercentage.toString(),
            value: changeValue.toString(),
          };
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

      // Calculate locked value (current reserves) for the selected token
      const currentReserves = reservesResult[0];
      const lockedValueAE = new BigNumber(
        currentReserves?.[`reserve${volumeToken}`] || 0,
      );

      // Get price data for locked value in multiple currencies
      const lockedValuePriceData =
        await this.aePricingService.getPriceData(lockedValueAE);

      return {
        address: pair.address,
        volume_token:
          volumeToken === '0' ? pair.token0?.address : pair.token1?.address,
        token_position: volumeToken,
        total_volume: totalVolumePriceData,
        total_locked_value: lockedValuePriceData,
        change: {
          '24h': periodData['24h'],
          '7d': periodData['7d'],
          '30d': periodData['30d'],
        },
      };
    } finally {
      await queryRunner.release();
    }
  }
}
