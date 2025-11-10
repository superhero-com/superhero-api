import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiOkResponse,
} from '@nestjs/swagger';
import { CoinGeckoService, CoinGeckoMarketResponse } from '@/ae/coin-gecko.service';
import { CurrencyRates } from '@/utils/types';
import { AETERNITY_COIN_ID } from '@/configs';

@Controller('pricing')
@ApiTags('Pricing')
export class PriceFeedController {
  constructor(private readonly coinGeckoService: CoinGeckoService) {}

  @ApiOperation({
    operationId: 'getCurrencyRates',
    summary: 'Get currency rates for Aeternity',
    description: 'Returns current or historical exchange rates for Aeternity. When "days" parameter is provided, returns historical price data. Otherwise returns current rates for all supported currencies.',
  })
  @ApiQuery({
    name: 'currency',
    type: 'string',
    required: false,
    description: 'Target currency code (default: usd). Only used when requesting historical data.',
    example: 'usd',
  })
  @ApiQuery({
    name: 'days',
    type: 'string',
    required: false,
    description: 'Number of days of history to fetch. Supported values: 1, 7, 14, 30, 90, 180, 365, max. If omitted, returns current rates.',
    example: '365',
  })
  @ApiQuery({
    name: 'interval',
    type: 'string',
    enum: ['daily', 'hourly'],
    required: false,
    description: 'Interval for historical data points (default: daily). Only used when "days" is provided. Note: hourly data may not be reliably available for all periods.',
    example: 'daily',
  })
  @ApiOkResponse({
    description: 'Currency rates (current) or historical price data (when days parameter is provided)',
    schema: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: { type: 'number' },
          example: { usd: 0.05, eur: 0.045, cny: 0.35 },
          description: 'Current rates object (when days parameter is omitted)',
        },
        {
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
          description: 'Historical price data as array of [timestamp_ms, price] pairs (when days parameter is provided)',
        },
      ],
    },
  })
  @Get('rates')
  async getCurrencyRates(
    @Query('currency') currency?: string,
    @Query('days') days?: string | number,
    @Query('interval') interval?: 'daily' | 'hourly',
  ): Promise<CurrencyRates | Array<[number, number]> | null> {
    // If days parameter is provided, return historical data
    if (days !== undefined && days !== null && days !== '') {
      return this.getHistoricalPriceData(currency, days, interval);
    }
    
    // Otherwise return current rates
    if (!this.coinGeckoService.rates || this.coinGeckoService.isPullTimeExpired()) {
      await this.coinGeckoService.pullData();
    }
    
    return this.coinGeckoService.rates;
  }

  @ApiOperation({
    operationId: 'getMarketData',
    summary: 'Get market data for Aeternity',
    description: 'Returns detailed market data including price, market cap, volume, etc.',
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
  @Get('market-data')
  async getMarketData(
    @Query('currency') currency: string = 'usd',
  ): Promise<Omit<CoinGeckoMarketResponse, 'image' | 'marketCapRank'> | null> {
    const data = await this.coinGeckoService.fetchCoinMarketData(
      AETERNITY_COIN_ID,
      currency,
    );
    
    if (!data) {
      return null;
    }
    
    // Remove 'image' and 'marketCapRank' from response
    const { image, marketCapRank, ...filteredData } = data;
    return filteredData as Omit<CoinGeckoMarketResponse, 'image' | 'marketCapRank'>;
  }

  /**
   * Helper method to get historical price data
   * Used internally by both /rates and /history endpoints
   */
  private async getHistoricalPriceData(
    currency: string = 'usd',
    days: string | number = '365',
    interval: 'daily' | 'hourly' = 'daily',
  ): Promise<Array<[number, number]>> {
    // Validate days parameter - CoinGecko supports: 1, 7, 14, 30, 90, 180, 365, max
    const validDays = [1, 7, 14, 30, 90, 180, 365];
    
    // Handle 'max' string or convert to number
    let finalDays: number;
    if (days === 'max' || days === 'Max' || days === 'MAX') {
      // For 'max', use 365 days (CoinGecko's fetchHistoricalPrice accepts number, not 'max' string)
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
          Math.abs(curr - daysValue) < Math.abs(prev - daysValue) ? curr : prev
        );
      }
    }
    
    return await this.coinGeckoService.fetchHistoricalPrice(
      AETERNITY_COIN_ID,
      currency,
      finalDays,
      interval,
    );
  }

  @ApiOperation({
    operationId: 'getHistoricalPrice',
    summary: 'Get historical price data for Aeternity (deprecated)',
    description: 'DEPRECATED: Use GET /api/pricing/rates?days=X instead. Returns historical price data for Aeternity in the specified currency. Used internally for portfolio calculations.',
    deprecated: true,
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
    description: 'Number of days of history to fetch. Supported values: 1, 7, 14, 30, 90, 180, 365, max (default: 365)',
    example: '365',
  })
  @ApiQuery({
    name: 'interval',
    type: 'string',
    enum: ['daily', 'hourly'],
    required: false,
    description: 'Interval for data points (default: daily). Note: hourly data may not be reliably available for all periods.',
    example: 'daily',
  })
  @ApiOkResponse({
    description: 'Historical price data as array of [timestamp_ms, price] pairs',
    schema: {
      type: 'array',
      items: {
        type: 'array',
        items: {
          type: 'number',
        },
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
  @Get('history')
  async getHistoricalPrice(
    @Query('currency') currency: string = 'usd',
    @Query('days') days: string | number = '365',
    @Query('interval') interval: 'daily' | 'hourly' = 'daily',
  ): Promise<Array<[number, number]>> {
    return this.getHistoricalPriceData(currency, days, interval);
  }
}

