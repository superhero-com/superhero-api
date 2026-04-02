import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiOkResponse,
} from '@nestjs/swagger';
import {
  CoinGeckoService,
  CoinGeckoMarketResponse,
} from '@/ae/coin-gecko.service';
import { CurrencyRates } from '@/utils/types';
import { AETERNITY_COIN_ID } from '@/configs';

@Controller('coins')
@ApiTags('Coins')
export class PriceFeedController {
  constructor(private readonly coinGeckoService: CoinGeckoService) {}

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
    enum: ['daily', 'hourly'],
    required: false,
    description:
      'Interval for historical data points (default: daily). Hourly interval is only available for 1-90 days. For days>90, only daily data is available.',
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
    @Query('interval') interval?: 'daily' | 'hourly',
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
   * Helper method to get historical price data.
   * Used internally by /history endpoint.
   */
  private async getHistoricalPriceData(
    coinId: string,
    currency: string = 'usd',
    days: string | number = '365',
    interval: 'daily' | 'hourly' = 'daily',
  ): Promise<Array<[number, number]>> {
    const validDays = [1, 7, 14, 30, 90, 180, 365];

    let finalDays: number;
    if (days === 'max' || days === 'Max' || days === 'MAX') {
      finalDays = 365;
    } else {
      const daysValue = Number(days);
      if (isNaN(daysValue) || daysValue <= 0) {
        finalDays = 365;
      } else if (validDays.includes(daysValue)) {
        finalDays = daysValue;
      } else {
        finalDays = validDays.reduce((prev, curr) =>
          Math.abs(curr - daysValue) < Math.abs(prev - daysValue) ? curr : prev,
        );
      }
    }

    // Hourly is only meaningful for 1–90 days; beyond that force daily.
    const finalInterval: 'daily' | 'hourly' =
      interval === 'hourly' && finalDays <= 90 ? 'hourly' : 'daily';

    return this.coinGeckoService.getHistoricalPrice(
      coinId,
      currency,
      finalDays,
      finalInterval,
    );
  }
}
