import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import BigNumber from 'bignumber.js';
import moment, { Moment } from 'moment';
import { readFileSync } from 'fs';
import { join } from 'path';
import camelcaseKeysDeep from 'camelcase-keys-deep';
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
  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {
    setInterval(() => this.pullData(), 1000 * 60 * 5); // 5 minutes
    this.pullData();
  }

  /**
   * Fetches the coin currency rates for Aeternity and assigns them to the `rates` property.
   */
  async pullData() {
    const rates = await this.fetchCoinCurrencyRates(AETERNITY_COIN_ID);
    if (rates) {
      this.rates = rates;
      this.last_pull_time = moment();
      // Cache the rates for 10 minutes (600 seconds)
      try {
        await this.cacheManager.set('coingecko:rates', rates, 600 * 1000);
        this.logger.debug('Cached currency rates');
      } catch (error) {
        this.logger.warn('Failed to cache currency rates:', error);
      }
    } else {
      // If API fails, try to use cached rates
      try {
        const cachedRates = await this.cacheManager.get<CurrencyRates>('coingecko:rates');
        if (cachedRates) {
          this.logger.log('Using cached currency rates due to API failure');
          this.rates = cachedRates;
          this.last_pull_time = moment(); // Update time to prevent immediate retry
        } else {
          // Try fallback from JSON file
          const fallbackRates = this.getFallbackRates();
          if (fallbackRates) {
            this.logger.log('Using fallback rates from JSON file');
            this.rates = fallbackRates;
            this.last_pull_time = moment();
          } else {
            this.logger.warn('No rates available from API, cache, or fallback');
          }
        }
      } catch (error) {
        this.logger.warn('Failed to read cached rates:', error);
        // Try fallback from JSON file
        const fallbackRates = this.getFallbackRates();
        if (fallbackRates) {
          this.logger.log('Using fallback rates from JSON file');
          this.rates = fallbackRates;
          this.last_pull_time = moment();
        }
      }
    }
  }

  isPullTimeExpired() {
    return (
      this.last_pull_time && moment().diff(this.last_pull_time, 'minutes') > 2
    );
  }

  /**
   * Gets fallback rates from the JSON file (uses latest USD price)
   * @returns CurrencyRates object with USD rate, or null if unavailable
   */
  private getFallbackRates(): CurrencyRates | null {
    try {
      const priceData = this.readFallbackPriceData();
      if (priceData && priceData.length > 0) {
        // Get the latest price by finding the entry with the highest timestamp
        const sortedByTime = [...priceData].sort((a, b) => b[0] - a[0]);
        const latestPrice = sortedByTime[0][1];
        if (latestPrice && typeof latestPrice === 'number') {
          this.logger.log(`Using fallback USD rate from JSON: ${latestPrice}`);
          // Return rates object with USD rate
          // Note: We only have USD rate from the JSON file, other currencies will be null
          return {
            usd: latestPrice,
          } as CurrencyRates;
        }
      }
      return null;
    } catch (error) {
      this.logger.error('Failed to get fallback rates:', error);
      return null;
    }
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

    // If rates are still null, try to get from cache or fallback
    if (this.rates === null) {
      this.logger.warn('CoinGecko rates are null after pullData, trying cache and fallback');
      try {
        const cachedRates = await this.cacheManager.get<CurrencyRates>('coingecko:rates');
        if (cachedRates) {
          this.logger.log('Using cached rates as fallback');
          this.rates = cachedRates;
        } else {
          const fallbackRates = this.getFallbackRates();
          if (fallbackRates) {
            this.logger.log('Using fallback rates from JSON file');
            this.rates = fallbackRates;
          }
        }
      } catch (error) {
        this.logger.warn('Failed to get cached or fallback rates:', error);
      }
    }

    // If still null, use fallback rates or return AE only
    if (this.rates === null) {
      this.logger.error('CoinGecko rates are null and no fallback available');
      // Return AE amount only, with null for other currencies
      const prices: any = {
        ae: price,
      };
      CURRENCIES.forEach(({ code }) => {
        prices[code] = null;
      });
      return prices;
    }

    const prices = {
      ae: price,
    };

    CURRENCIES.forEach(({ code }) => {
      try {
        const rate = this.rates![code];
        if (rate != null && typeof rate === 'number') {
          const converted = price.multipliedBy(rate);
          prices[code] = converted;
          this.logger.debug(
            `Converted ${price.toString()} AE to ${code}: ${converted.toString()} (rate: ${rate})`,
          );
        } else {
          this.logger.warn(`No rate available for ${code}`);
          prices[code] = null;
        }
      } catch (error) {
        this.logger.error(`Failed to calculate price for ${code}:`, error);
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
    const url = `${COIN_GECKO_API_URL}${path}?${query}`;
    console.log('[CoinGeckoService] fetchFromApi', url);
    return fetchJson(url);
  }

  /**
   * Obtain all the coin rates for the currencies used in the app.
   */
  async fetchCoinCurrencyRates(coinId: string): Promise<CurrencyRates | null> {
    try {
      const response = (await this.fetchFromApi('/simple/price', {
        ids: coinId,
        vs_currencies: CURRENCIES.map(({ code }) => code).join(','),
      })) as any;

      const rates = response[coinId];
      if (rates) {
        this.logger.debug(
          `Fetched CoinGecko rates for ${coinId}:`,
          JSON.stringify(rates),
        );
        return rates;
      }
      this.logger.warn(`No rates found in CoinGecko response for ${coinId}`);
      return null;
    } catch (error) {
      this.logger.error(
        `Failed to fetch CoinGecko rates for ${coinId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Obtain all the coin market data (price, market cap, volume, etc...)
   * @param coinId - The CoinGecko coin ID (e.g., 'aeternity')
   * @param currencyCode - The target currency code (e.g., 'usd')
   * @returns Market data response or null if fetch fails
   */
  async fetchCoinMarketData(
    coinId: string,
    currencyCode: string,
  ): Promise<CoinGeckoMarketResponse | null> {
    try {
      const marketData = (await this.fetchFromApi('/coins/markets', {
        ids: coinId,
        vs_currency: currencyCode,
      })) as any[];

      if (marketData && marketData.length > 0) {
        const result = camelcaseKeysDeep(marketData[0]) as CoinGeckoMarketResponse;
        this.logger.debug(
          `Fetched CoinGecko market data for ${coinId} in ${currencyCode}`,
        );
        return result;
      }
      this.logger.warn(`No market data found in CoinGecko response for ${coinId}`);
      return null;
    } catch (error) {
      this.logger.error(
        `Failed to fetch CoinGecko market data for ${coinId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Reads historical price data from the fallback JSON file
   * @returns Array of [timestamp_ms, price] pairs from the JSON file
   */
  private readFallbackPriceData(): Array<[number, number]> {
    try {
      const filePath = join(process.cwd(), 'src', 'data', 'ae-pricing.json');
      const fileContent = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(fileContent);
      
      if (data?.prices && Array.isArray(data.prices)) {
        this.logger.log(
          `Loaded fallback price data from JSON file: ${data.prices.length} price points`,
        );
        return data.prices;
      }
      
      this.logger.error('Fallback JSON file does not contain valid prices array');
      return [];
    } catch (error) {
      this.logger.error('Failed to read fallback price data from JSON file:', error);
      return [];
    }
  }

  /**
   * Fetch historical price data for a coin (with caching)
   * @param coinId - The CoinGecko coin ID (e.g., 'aeternity')
   * @param vsCurrency - The target currency (e.g., 'usd')
   * @param days - Number of days of history to fetch (1, 7, 14, 30, 90, 180, 365, max)
   * @param interval - Interval for data points ('daily' or 'hourly'), defaults to 'daily'. If undefined, interval parameter is omitted from API call.
   * @returns Array of [timestamp_ms, price] pairs (never null)
   */
  async fetchHistoricalPrice(
    coinId: string,
    vsCurrency: string,
    days: number = 365,
    interval?: 'daily' | 'hourly',
  ): Promise<Array<[number, number]>> {
    // Create cache key based on coin, currency, days, and interval
    const cacheKey = `coingecko:historical:${coinId}:${vsCurrency}:${days}:${interval || 'none'}`;

    // Try to get from cache first
    try {
      const cached =
        await this.cacheManager.get<Array<[number, number]>>(cacheKey);
      if (cached) {
        this.logger.debug(
          `Using cached historical price data for ${coinId} (${vsCurrency}, ${days}d, ${interval || 'none'})`,
        );
        return cached;
      }
    } catch (error) {
      this.logger.warn(`Cache read error for ${cacheKey}:`, error);
    }

    // If not in cache, fetch from CoinGecko
    try {
      const searchParams: Record<string, string> = {
        vs_currency: vsCurrency,
        days: String(days),
      };
      
      // Only add interval parameter if provided
      if (interval) {
        searchParams.interval = interval;
      }
      
      const response = (await this.fetchFromApi(
        `/coins/${coinId}/market_chart`,
        searchParams,
      )) as {
        prices?: [number, number][];
        status?: { error_code: number; error_message: string };
      };

      // Check for CoinGecko API errors (e.g., rate limiting)
      if (response?.status?.error_code) {
        if (response.status.error_code === 429) {
          this.logger.warn(
            `CoinGecko rate limit hit (429). Attempting to use cached data if available, or will fall back to JSON file.`,
          );
          // Try to get from cache even if stale (it might have expired but still be useful)
          try {
            const staleCache =
              await this.cacheManager.get<Array<[number, number]>>(cacheKey);
            if (staleCache && staleCache.length > 0) {
              this.logger.log(
                `Using stale cached data due to rate limit: ${staleCache.length} price points`,
              );
              return staleCache;
            }
          } catch (cacheError) {
            this.logger.warn(`Could not read stale cache:`, cacheError);
          }
          // If no stale cache available, fall back to JSON file
          this.logger.log('No stale cache available, falling back to JSON file');
          return this.readFallbackPriceData();
        }
        this.logger.error(
          `CoinGecko API error: ${response.status.error_code} - ${response.status.error_message}. Falling back to JSON file.`,
        );
        return this.readFallbackPriceData();
      }

      const prices = response?.prices || null;

      // Cache the result for 1 hour (3600 seconds)
      // Historical data doesn't change frequently, so this reduces API calls significantly
      if (prices && prices.length > 0) {
        // Log first and last price points for debugging
        const firstPrice = prices[0];
        const lastPrice = prices[prices.length - 1];
        this.logger.log(
          `CoinGecko returned ${prices.length} price points. First: ${moment(firstPrice[0]).toISOString()} = ${firstPrice[1]} ${vsCurrency}, Last: ${moment(lastPrice[0]).toISOString()} = ${lastPrice[1]} ${vsCurrency}`,
        );

        try {
          await this.cacheManager.set(cacheKey, prices, 3600 * 1000); // TTL in milliseconds
          this.logger.debug(
            `Cached historical price data for ${coinId} (${vsCurrency}, ${days}d, ${interval}): ${prices.length} data points`,
          );
        } catch (error) {
          this.logger.warn(`Cache write error for ${cacheKey}:`, error);
        }

        return prices;
      } else {
        this.logger.warn(
          `CoinGecko returned empty or invalid price data for ${coinId}. Response keys: ${Object.keys(response || {})}. Falling back to JSON file.`,
        );
        return this.readFallbackPriceData();
      }
    } catch (error) {
      this.logger.warn(
        `Failed to fetch historical price for ${coinId}:`,
        error,
      );
      this.logger.log('Falling back to JSON file data');
      return this.readFallbackPriceData();
    }
  }
}
