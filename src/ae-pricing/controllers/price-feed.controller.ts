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
    description: 'Returns the current exchange rates for Aeternity in all supported currencies',
  })
  @ApiOkResponse({
    description: 'Currency rates object',
    schema: {
      type: 'object',
      additionalProperties: { type: 'number' },
      example: { usd: 0.05, eur: 0.045, cny: 0.35 },
    },
  })
  @Get('rates')
  async getCurrencyRates(): Promise<CurrencyRates | null> {
    // Ensure we have fresh rates
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
}

