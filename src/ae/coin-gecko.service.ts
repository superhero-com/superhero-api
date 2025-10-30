import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import BigNumber from 'bignumber.js';
import moment, { Moment } from 'moment';
import { AETERNITY_COIN_ID, CURRENCIES } from '@/configs';
import { IPriceDto } from '@/tokens/dto/price.dto';
import { fetchJson } from '@/utils/common';
import { CurrencyRates } from '@/utils/types';

const COIN_GECKO_API_URL = 'https://api.coingecko.com/api/v3';

export interface CoinGeckoMarketResponse {
  ath: number;
  athChangePercentage: number;
  athDate: string;
  atl: number;
  atlChangePercentage: number;
  atlDate: string;
  circulatingSupply: number;
  currentPrice: number;
  fullyDilutedValuation: any;
  high24h: number;
  id: string;
  image: string;
  lastUpdated: string;
  low24h: number;
  marketCap: number;
  marketCapChange24h: number;
  marketCapChangePercentage24h: number;
  marketCapRank: number;
  maxSupply: any;
  name: string;
  priceChange24h: number;
  priceChangePercentage24h: number;
  roi: object;
  symbol: string;
  totalSupply: number;
  totalVolume: number;
}

@Injectable()
export class CoinGeckoService {
  private readonly logger = new Logger(CoinGeckoService.name);
  rates: CurrencyRates | null = null;
  last_pull_time: Moment;

  /**
   * CoinGeckoService class responsible for pulling data at regular intervals.
   */
  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {
    setInterval(() => this.pullData(), 1000 * 60 * 5); // 5 minutes
    this.pullData();
  }

  /**
   * Fetches the coin currency rates for Aeternity and assigns them to the `rates` property.
   */
  pullData() {
    this.fetchCoinCurrencyRates(AETERNITY_COIN_ID).then((rates) => {
      this.rates = rates;
      this.last_pull_time = moment();
    });
  }

  isPullTimeExpired() {
    return (
      this.last_pull_time && moment().diff(this.last_pull_time, 'minutes') > 2
    );
  }

  /**
   * Retrieves the price data for a given amount of AE tokens.
   * @param price - The amount of AE tokens.
   * @returns An object containing the price data for AE and other currencies.
   */
  async getPriceData(price: BigNumber): Promise<IPriceDto> {
    if (this.rates === null || this.isPullTimeExpired()) {
      await this.pullData();
    }

    const prices = {
      ae: price,
    };

    CURRENCIES.forEach(({ code }) => {
      try {
        prices[code] = this.rates![code]
          ? price.multipliedBy(this.rates![code])
          : null;
      } catch (error) {
        // console.warn(`Failed to calculate price for ${code}`);
        prices[code] = null;
      }
    });

    return prices as any;
  }

  /**
   * Fetches data from the Coin Gecko API.
   *
   * @param path - The API endpoint path.
   * @param searchParams - The search parameters to be included in the request.
   * @returns A Promise that resolves to the fetched data.
   */
  fetchFromApi(path: string, searchParams: Record<string, string>) {
    const query = new URLSearchParams(searchParams).toString();

    return fetchJson(`${COIN_GECKO_API_URL}${path}?${query}`);
  }

  /**
   * Obtain all the coin rates for the currencies used in the app.
   */
  async fetchCoinCurrencyRates(coinId: string): Promise<CurrencyRates | null> {
    try {
      return (
        (await this.fetchFromApi('/simple/price', {
          ids: coinId,
          vs_currencies: CURRENCIES.map(({ code }) => code).join(','),
        })) as any
      )[coinId];
    } catch (error) {
      return null;
    }
  }

  /**
   * Fetch historical price data for a coin (with caching)
   * @param coinId - The CoinGecko coin ID (e.g., 'aeternity')
   * @param vsCurrency - The target currency (e.g., 'usd')
   * @param days - Number of days of history to fetch (1, 7, 14, 30, 90, 180, 365, max)
   * @param interval - Interval for data points ('daily' or 'hourly'), defaults to 'daily'
   * @returns Array of [timestamp_ms, price] pairs
   */
  async fetchHistoricalPrice(
    coinId: string,
    vsCurrency: string,
    days: number = 365,
    interval: 'daily' | 'hourly' = 'daily',
  ): Promise<Array<[number, number]> | null> {
    // Create cache key based on coin, currency, days, and interval
    const cacheKey = `coingecko:historical:${coinId}:${vsCurrency}:${days}:${interval}`;
    
    // Try to get from cache first
    try {
      const cached = await this.cacheManager.get<Array<[number, number]>>(cacheKey);
      if (cached) {
        this.logger.debug(`Using cached historical price data for ${coinId} (${vsCurrency}, ${days}d, ${interval})`);
        return cached;
      }
    } catch (error) {
      this.logger.warn(`Cache read error for ${cacheKey}:`, error);
    }

    // If not in cache, fetch from CoinGecko
    try {
      const response = await this.fetchFromApi(
        `/coins/${coinId}/market_chart`,
        {
          vs_currency: vsCurrency,
          days: String(days),
          interval: interval,
        }
      ) as { prices?: [number, number][]; status?: { error_code: number; error_message: string } };
      
      // Check for CoinGecko API errors (e.g., rate limiting)
      if (response?.status?.error_code) {
        this.logger.error(`CoinGecko API error: ${response.status.error_code} - ${response.status.error_message}`);
        return null;
      }
      
      const prices = response?.prices || null;
      
      // Cache the result for 1 hour (3600 seconds)
      // Historical data doesn't change frequently, so this reduces API calls significantly
      if (prices && prices.length > 0) {
        try {
          await this.cacheManager.set(cacheKey, prices, 3600 * 1000); // TTL in milliseconds
          this.logger.debug(`Cached historical price data for ${coinId} (${vsCurrency}, ${days}d, ${interval}): ${prices.length} data points`);
        } catch (error) {
          this.logger.warn(`Cache write error for ${cacheKey}:`, error);
        }
      } else {
        this.logger.warn(`CoinGecko returned empty or invalid price data for ${coinId}`);
      }
      
      return prices;
    } catch (error) {
      this.logger.warn(`Failed to fetch historical price for ${coinId}:`, error);
      return null;
    }
  }
}
