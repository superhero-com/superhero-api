import { Controller, Get, Query, Inject } from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiOkResponse,
} from '@nestjs/swagger';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import {
  CoinGeckoService,
  CoinGeckoMarketResponse,
} from '@/ae/coin-gecko.service';
import { CurrencyRates } from '@/utils/types';
import { AETERNITY_COIN_ID } from '@/configs';

@Controller('coins')
@ApiTags('Coins')
export class PriceFeedController {
  constructor(
    private readonly coinGeckoService: CoinGeckoService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  @ApiOperation({
    operationId: 'getCurrencyRates',
    summary: 'Get current currency rates for Aeternity',
    description:
      'Returns current exchange rates for Aeternity in all supported fiat currencies.',
  })
  @ApiOkResponse({
    description: 'Current currency rates for all supported fiat currencies',
    schema: {
      type: 'object',
      additionalProperties: { type: 'number' },
      example: {
        usd: 0.05,
        eur: 0.045,
        aud: 0.075,
        brl: 0.25,
        cad: 0.068,
        chf: 0.044,
        gbp: 0.039,
        xau: 0.000025,
      },
    },
  })
  @Get('aeternity/rates')
  async getCurrencyRates(): Promise<CurrencyRates> {
    // Serve best-available (cached/last-known-good) rates to avoid intermittent {}
    return this.coinGeckoService.getAeternityRates();
  }

  @ApiOperation({
    operationId: 'getHistoricalPrice',
    summary: 'Get historical price data for Aeternity',
    description:
      'Returns historical price data for Aeternity as an array of [timestamp_ms, price] pairs.',
  })
  @ApiQuery({
    name: 'currency',
    type: 'string',
    required: false,
    description: 'Target currency code (default: usd)',
    example: 'usd',
  })
  @ApiQuery({
    name: 'days',
    type: 'string',
    required: false,
    description:
      'Number of days of history to fetch. Supported values: 1, 7, 14, 30, 90, 180, 365, max. Default: 365',
    example: '365',
  })
  @ApiQuery({
    name: 'interval',
    type: 'string',
    enum: ['daily', 'hourly', 'minute'],
    required: false,
    description:
      'Interval for historical data points (default: daily). Minute interval is only available for 1 day. Hourly interval is only available for 1-90 days. For days>90, only daily data is available.',
    example: 'daily',
  })
  @ApiOkResponse({
    description:
      'Historical price data as array of [timestamp_ms, price] pairs',
    schema: {
      type: 'array',
      items: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        example: [1704067200000, 0.00504577],
      },
      example: [
        [1704067200000, 0.00504577],
        [1704153600000, 0.00512345],
      ],
    },
  })
  @Get('aeternity/history')
  async getHistoricalPrice(
    @Query('currency') currency?: string,
    @Query('days') days?: string | number,
    @Query('interval') interval?: 'daily' | 'hourly' | 'minute',
  ): Promise<Array<[number, number]>> {
    return this.getHistoricalPriceData(
      AETERNITY_COIN_ID,
      currency,
      days,
      interval,
    );
  }

  @ApiOperation({
    operationId: 'getMarketData',
    summary: 'Get market data for Aeternity',
    description:
      'Returns detailed market data including price, market cap, volume, etc.',
  })
  @ApiQuery({
    name: 'currency',
    type: 'string',
    required: false,
    description: 'Target currency code (default: usd)',
    example: 'usd',
  })
  @ApiOkResponse({
    description: 'Market data response',
    type: Object,
  })
  @Get('aeternity/market-data')
  async getMarketData(
    @Query('currency') currency: string = 'usd',
  ): Promise<Omit<CoinGeckoMarketResponse, 'image' | 'marketCapRank'>> {
    // Serve best-available (cached/last-known-good) market data to avoid intermittent {}
    const data = await this.coinGeckoService.getCoinMarketData(
      AETERNITY_COIN_ID,
      currency,
    );

    // Remove 'image' and 'marketCapRank' from response
    const filteredData = Object.fromEntries(
      Object.entries(data).filter(
        ([key]) => key !== 'image' && key !== 'marketCapRank',
      ),
    );
    return filteredData as Omit<
      CoinGeckoMarketResponse,
      'image' | 'marketCapRank'
    >;
  }

  /**
   * Aggregates minute-level data into hourly buckets
   * @param minuteData Array of [timestamp_ms, price] pairs with minute-level granularity
   * @returns Array of [timestamp_ms, price] pairs aggregated to hourly intervals (24 data points for 1 day)
   */
  private aggregateToHourly(
    minuteData: Array<[number, number]>,
  ): Array<[number, number]> {
    if (minuteData.length === 0) {
      return [];
    }

    // Group data points by hour
    const hourlyBuckets = new Map<number, number[]>();

    for (const [timestamp, price] of minuteData) {
      // Round down to the start of the hour (in milliseconds)
      const hourStart =
        Math.floor(timestamp / (1000 * 60 * 60)) * (1000 * 60 * 60);

      if (!hourlyBuckets.has(hourStart)) {
        hourlyBuckets.set(hourStart, []);
      }
      hourlyBuckets.get(hourStart)!.push(price);
    }

    // Aggregate each hour's prices (using average)
    const hourlyData: Array<[number, number]> = [];
    const sortedHours = Array.from(hourlyBuckets.keys()).sort((a, b) => a - b);

    for (const hourStart of sortedHours) {
      const prices = hourlyBuckets.get(hourStart)!;
      // Calculate average price for this hour
      const avgPrice =
        prices.reduce((sum, price) => sum + price, 0) / prices.length;
      hourlyData.push([hourStart, avgPrice]);
    }

    return hourlyData;
  }

  /**
   * Helper method to get historical price data
   * Used internally by /history endpoint
   */
  private async getHistoricalPriceData(
    coinId: string,
    currency: string = 'usd',
    days: string | number = '365',
    interval: 'daily' | 'hourly' | 'minute' = 'daily',
  ): Promise<Array<[number, number]>> {
    // Validate days parameter - supported values: 1, 7, 14, 30, 90, 180, 365, max
    const validDays = [1, 7, 14, 30, 90, 180, 365];

    // Handle 'max' string or convert to number
    let finalDays: number;
    if (days === 'max' || days === 'Max' || days === 'MAX') {
      // For 'max', use 365 days (the service accepts number, not 'max' string)
      // The service will handle the conversion internally if needed
      finalDays = 365; // Using max available for now
    } else {
      const daysValue = Number(days);
      if (isNaN(daysValue) || daysValue <= 0) {
        finalDays = 365; // Default to 365 if invalid
      } else if (validDays.includes(daysValue)) {
        finalDays = daysValue;
      } else {
        // Find closest valid value
        finalDays = validDays.reduce((prev, curr) =>
          Math.abs(curr - daysValue) < Math.abs(prev - daysValue) ? curr : prev,
        );
      }
    }

    // Handle interval parameter based on days value
    let finalInterval: 'daily' | 'hourly' | undefined;
    let shouldAggregateToHourly = false;

    // For days=1: minute-level data (~5 min intervals) is returned automatically when interval is omitted
    if (finalDays === 1) {
      if (interval === 'hourly') {
        // For days=1 with hourly, fetch minute-level data and aggregate to 24 hourly data points
        shouldAggregateToHourly = true;
        finalInterval = undefined; // Omit interval to get minute-level data
      } else if (interval === 'minute') {
        // For days=1 with minute, return minute-level data as-is
        finalInterval = undefined;
      } else {
        // For days=1 with daily, use daily (returns 2 data points: start/end of day)
        finalInterval = 'daily';
      }
    } else if (interval === 'minute') {
      // Minute interval only works for days=1, so force days=1 and omit interval
      finalDays = 1;
      finalInterval = undefined; // CoinGecko returns minute data for days=1 automatically
    } else {
      // For other cases, use the requested interval or default to daily
      finalInterval = interval === 'hourly' ? 'hourly' : 'daily';
    }

    // If we need aggregated hourly data, check cache first
    if (shouldAggregateToHourly && finalDays === 1) {
      const aggregatedCacheKey = `coingecko:historical:aggregated:hourly:${coinId}:${currency}:${finalDays}`;
      try {
        const cached =
          await this.cacheManager.get<Array<[number, number]>>(
            aggregatedCacheKey,
          );
        if (cached) {
          return cached;
        }
      } catch (error) {
        // If cache read fails, continue to fetch and aggregate
      }
    }

    // Fetch data from CoinGecko
    const data = await this.coinGeckoService.fetchHistoricalPrice(
      coinId,
      currency,
      finalDays,
      finalInterval,
    );

    // If we need to aggregate to hourly, do it now and cache the result
    if (shouldAggregateToHourly && finalDays === 1) {
      const aggregatedData = this.aggregateToHourly(data);
      const aggregatedCacheKey = `coingecko:historical:aggregated:hourly:${coinId}:${currency}:${finalDays}`;
      try {
        // Cache aggregated hourly data for 1 hour (same as raw data)
        await this.cacheManager.set(
          aggregatedCacheKey,
          aggregatedData,
          3600 * 1000,
        );
      } catch (error) {
        // If cache write fails, still return the aggregated data
      }
      return aggregatedData;
    }

    return data;
  }
}
