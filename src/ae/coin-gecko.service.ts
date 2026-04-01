import {
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  forwardRef,
} from '@nestjs/common';
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
import { CoinHistoricalPriceService } from '@/ae-pricing/services/coin-historical-price.service';

const COIN_GECKO_API_URL = 'https://api.coingecko.com/api/v3';
const DEFAULT_MARKET_DATA_MAX_AGE_MS = 3 * 60 * 1000;

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
  private ratesPullInFlight: Promise<void> | null = null;
  private marketDataInFlight = new Map<
    string,
    Promise<CoinGeckoMarketResponse>
  >();
  private readonly marketCacheKeyPrefix = 'coingecko:market:v1';

  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    @Optional()
    @Inject(forwardRef(() => CoinHistoricalPriceService))
    private historicalPriceService?: CoinHistoricalPriceService,
  ) {
    // Initial data warm-up is triggered by AppService.init() on startup via syncAllFromApi().
    // Periodic refresh is handled by the @Cron(EVERY_10_MINUTES) in AppService.
  }

  /**
   * Called by the 10-minute cron job in AppService and on startup.
   * Fetches fresh data from CoinGecko for all endpoints and populates memory / Redis / DB.
   * This is the ONLY place that makes outbound CoinGecko HTTP calls.
   */
  async syncAllFromApi(): Promise<void> {
    // 1. Fetch spot rates (/simple/price) → memory + Redis
    await this.pullData();

    // 2. Fetch market data (/coins/markets) → Redis
    try {
      const marketData = await this.fetchCoinMarketData(AETERNITY_COIN_ID, 'usd');
      if (marketData) {
        type CachedMarket = { data: CoinGeckoMarketResponse; fetchedAt: number };
        const cacheKey = `${this.marketCacheKeyPrefix}:${AETERNITY_COIN_ID}:usd`;
        const payload: CachedMarket = { data: marketData, fetchedAt: Date.now() };
        await this.cacheManager.set(cacheKey, payload, 24 * 60 * 60 * 1000);
        this.logger.debug('Synced market data from CoinGecko');
      }
    } catch (error) {
      this.logger.error('Failed to sync market data from CoinGecko:', error);
    }

    // 3. Fetch historical price data (/coins/{id}/market_chart) → DB + Redis
    try {
      await this.refreshHistoricalPrice(AETERNITY_COIN_ID, 'usd', 365, 'daily');
      this.logger.debug('Synced 365d daily historical prices from CoinGecko');
    } catch (error) {
      this.logger.error('Failed to sync 365d historical prices from CoinGecko:', error);
    }

    try {
      await this.refreshHistoricalPrice(AETERNITY_COIN_ID, 'usd', 7, 'daily');
      this.logger.debug('Synced 7d daily historical prices from CoinGecko');
    } catch (error) {
      this.logger.error('Failed to sync 7d historical prices from CoinGecko:', error);
    }
  }

  isPullTimeExpired() {
    if (!this.last_pull_time) return true;
    return moment().diff(this.last_pull_time, 'minutes') > 2;
  }

  /**
   * Returns the best-available currency rates from memory / Redis / fallback JSON.
   * Never triggers a live CoinGecko API call — data is kept fresh by syncAllFromApi().
   */
  async getAeternityRates(): Promise<CurrencyRates> {
    if (this.rates && !this.isPullTimeExpired()) {
      return this.rates;
    }

    // Try Redis cache
    try {
      const cachedRates =
        await this.cacheManager.get<CurrencyRates>('coingecko:rates');
      if (cachedRates) {
        this.rates = cachedRates;
        this.last_pull_time = moment();
        return cachedRates;
      }
    } catch (error) {
      this.logger.warn('Failed to read cached rates in getAeternityRates:', error);
    }

    // Try fallback JSON
    const fallbackRates = this.getFallbackRates();
    if (fallbackRates) {
      this.rates = fallbackRates;
      this.last_pull_time = moment();
      return fallbackRates;
    }

    throw new ServiceUnavailableException(
      'Aeternity rates are temporarily unavailable',
    );
  }

  /**
   * Retrieves the price data for a given amount of AE tokens.
   * Reads rates from memory / Redis / fallback — never triggers a live API call.
   * @param price - The amount of AE tokens.
   * @returns An object containing the price data for AE and other currencies.
   */
  async getPriceData(price: BigNumber): Promise<IPriceDto> {
    // Ensure we have rates from memory, Redis cache, or fallback
    if (this.rates === null || this.isPullTimeExpired()) {
      try {
        const cachedRates =
          await this.cacheManager.get<CurrencyRates>('coingecko:rates');
        if (cachedRates) {
          this.rates = cachedRates;
          this.last_pull_time = moment();
        } else {
          const fallbackRates = this.getFallbackRates();
          if (fallbackRates) {
            this.rates = fallbackRates;
            this.last_pull_time = moment();
          }
        }
      } catch (error) {
        this.logger.warn('Failed to get cached or fallback rates:', error);
      }
    }

    if (this.rates === null) {
      this.logger.error('CoinGecko rates are null and no fallback available');
      const prices: any = { ae: price };
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
   * Returns market data from Redis cache only.
   * Fresh data is kept populated by syncAllFromApi().
   * Returns stale cached data if cache exists; throws 503 if cache is empty.
   */
  async getCoinMarketData(
    coinId: string,
    currencyCode: string,
    maxAgeMs: number = DEFAULT_MARKET_DATA_MAX_AGE_MS,
  ): Promise<CoinGeckoMarketResponse> {
    const cacheKey = `${this.marketCacheKeyPrefix}:${coinId}:${currencyCode}`;

    type CachedMarket = { data: CoinGeckoMarketResponse; fetchedAt: number };

    let cached: CachedMarket | null = null;
    try {
      cached = (await this.cacheManager.get<CachedMarket>(cacheKey)) ?? null;
      const fetchedAtOk =
        cached &&
        typeof cached.fetchedAt === 'number' &&
        Number.isFinite(cached.fetchedAt);
      if (cached?.data && fetchedAtOk) {
        const ageMs = Date.now() - cached.fetchedAt;
        if (ageMs > maxAgeMs) {
          this.logger.debug(
            `Market data cache is ${Math.round(ageMs / 1000)}s old (max ${Math.round(maxAgeMs / 1000)}s); serving stale until next cron sync`,
          );
        }
        return cached.data;
      }
    } catch (error) {
      this.logger.warn(`Failed to read market cache (${cacheKey}):`, error);
    }

    throw new ServiceUnavailableException(
      'Aeternity market data is temporarily unavailable',
    );
  }

  /**
   * Returns historical price data from Redis cache or DB only.
   * Never calls the CoinGecko API — data is kept fresh by syncAllFromApi().
   * Falls back to the bundled ae-pricing.json if both cache and DB are empty.
   */
  async getHistoricalPrice(
    coinId: string,
    vsCurrency: string,
    days: number = 365,
    interval?: 'daily' | 'hourly',
  ): Promise<Array<[number, number]>> {
    const cacheKey = `coingecko:historical:${coinId}:${vsCurrency}:${days}:${interval || 'none'}`;

    // 1. Redis cache
    try {
      const cached =
        await this.cacheManager.get<Array<[number, number]>>(cacheKey);
      if (cached) {
        this.logger.debug(
          `Using Redis cached historical price data for ${coinId} (${vsCurrency}, ${days}d, ${interval || 'none'})`,
        );
        return cached;
      }
    } catch (error) {
      this.logger.warn(`Cache read error for ${cacheKey}:`, error);
    }

    // 2. DB
    if (this.historicalPriceService) {
      try {
        const now = moment();
        const endTimeMs = now.valueOf();
        const startTimeMs = now.subtract(days, 'days').valueOf();

        const dbData = await this.historicalPriceService.getHistoricalPriceData(
          coinId,
          vsCurrency,
          startTimeMs,
          endTimeMs,
        );

        if (dbData.length > 0) {
          this.logger.debug(
            `Serving ${dbData.length} historical price points from DB for ${coinId}`,
          );
          try {
            await this.cacheManager.set(cacheKey, dbData, 3600 * 1000);
          } catch (cacheError) {
            this.logger.warn(`Cache write error for ${cacheKey}:`, cacheError);
          }
          return dbData;
        }
      } catch (error) {
        this.logger.warn('Failed to query DB for historical prices:', error);
      }
    }

    // 3. Fallback JSON file
    this.logger.warn(
      `No historical price data in cache or DB for ${coinId}/${vsCurrency}/${days}d; using fallback JSON`,
    );
    return this.readFallbackPriceData();
  }

  /**
   * Fetches the coin currency rates for Aeternity and assigns them to the `rates` property.
   * Updates Redis cache. Called only by syncAllFromApi().
   */
  private async pullData() {
    const rates = await this.fetchCoinCurrencyRates(AETERNITY_COIN_ID);
    if (rates) {
      this.rates = rates;
      this.last_pull_time = moment();
      try {
        await this.cacheManager.set('coingecko:rates', rates, 600 * 1000);
        this.logger.debug('Cached currency rates');
      } catch (error) {
        this.logger.warn('Failed to cache currency rates:', error);
      }
    } else {
      // If API fails, try to use cached rates
      try {
        const cachedRates =
          await this.cacheManager.get<CurrencyRates>('coingecko:rates');
        if (cachedRates) {
          this.logger.log('Using cached currency rates due to API failure');
          this.rates = cachedRates;
          this.last_pull_time = moment();
        } else {
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
        const fallbackRates = this.getFallbackRates();
        if (fallbackRates) {
          this.logger.log('Using fallback rates from JSON file');
          this.rates = fallbackRates;
          this.last_pull_time = moment();
        }
      }
    }
  }

  /**
   * Gets fallback rates from the JSON file (uses latest USD price).
   * @returns CurrencyRates object with USD rate, or null if unavailable
   */
  private getFallbackRates(): CurrencyRates | null {
    try {
      const priceData = this.readFallbackPriceData();
      if (priceData && priceData.length > 0) {
        const sortedByTime = [...priceData].sort((a, b) => b[0] - a[0]);
        const latestPrice = sortedByTime[0][1];
        if (latestPrice && typeof latestPrice === 'number') {
          this.logger.log(`Using fallback USD rate from JSON: ${latestPrice}`);
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
   * Fetches data from the CoinGecko API.
   * Private — only called from within this service.
   */
  private fetchFromApi(path: string, searchParams: Record<string, string>) {
    const query = new URLSearchParams(searchParams).toString();
    const url = `${COIN_GECKO_API_URL}${path}?${query}`;
    return fetchJson(url);
  }

  /**
   * Obtain all the coin rates for the currencies used in the app.
   * Private — only called from pullData() → syncAllFromApi().
   */
  private async fetchCoinCurrencyRates(coinId: string): Promise<CurrencyRates | null> {
    try {
      const response = (await this.fetchFromApi('/simple/price', {
        ids: coinId,
        vs_currencies: CURRENCIES.map(({ code }) => code).join(','),
      })) as any;

      if (!response || typeof response !== 'object') {
        this.logger.warn(
          `Invalid CoinGecko rates response for ${coinId} (non-object)`,
        );
        return null;
      }

      const rates = response?.[coinId];
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
   * Obtain all the coin market data (price, market cap, volume, etc...).
   * Private — only called from syncAllFromApi().
   * @param coinId - The CoinGecko coin ID (e.g., 'aeternity')
   * @param currencyCode - The target currency code (e.g., 'usd')
   * @returns Market data response or null if fetch fails
   */
  private async fetchCoinMarketData(
    coinId: string,
    currencyCode: string,
  ): Promise<CoinGeckoMarketResponse | null> {
    try {
      const marketData = (await this.fetchFromApi('/coins/markets', {
        ids: coinId,
        vs_currency: currencyCode,
      })) as any[];

      if (!Array.isArray(marketData)) {
        this.logger.warn(
          `Invalid CoinGecko market data response for ${coinId} in ${currencyCode} (non-array)`,
        );
        return null;
      }

      if (marketData.length > 0) {
        const result = camelcaseKeysDeep(
          marketData[0],
        ) as CoinGeckoMarketResponse;
        this.logger.debug(
          `Fetched CoinGecko market data for ${coinId} in ${currencyCode}`,
        );
        return result;
      }
      this.logger.warn(
        `No market data found in CoinGecko response for ${coinId}`,
      );
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
   * Reads historical price data from the fallback JSON file.
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

      this.logger.error(
        'Fallback JSON file does not contain valid prices array',
      );
      return [];
    } catch (error) {
      this.logger.error(
        'Failed to read fallback price data from JSON file:',
        error,
      );
      return [];
    }
  }

  /**
   * Fetches and persists historical price data from CoinGecko (DB + Redis).
   * Private — only called from syncAllFromApi() to keep caches warm.
   * @param coinId - The CoinGecko coin ID (e.g., 'aeternity')
   * @param vsCurrency - The target currency (e.g., 'usd')
   * @param days - Number of days of history to fetch (1, 7, 14, 30, 90, 180, 365, max)
   * @param interval - Interval for data points ('daily' or 'hourly'). If undefined, interval parameter is omitted from API call.
   * @returns Array of [timestamp_ms, price] pairs (never null)
   */
  private async refreshHistoricalPrice(
    coinId: string,
    vsCurrency: string,
    days: number = 365,
    interval?: 'daily' | 'hourly',
  ): Promise<Array<[number, number]>> {
    const cacheKey = `coingecko:historical:${coinId}:${vsCurrency}:${days}:${interval || 'none'}`;

    // Try to get from Redis cache first (for very recent requests, 1 hour TTL)
    try {
      const cached =
        await this.cacheManager.get<Array<[number, number]>>(cacheKey);
      if (cached) {
        this.logger.debug(
          `Using Redis cached historical price data for ${coinId} (${vsCurrency}, ${days}d, ${interval || 'none'})`,
        );
        return cached;
      }
    } catch (error) {
      this.logger.warn(`Cache read error for ${cacheKey}:`, error);
    }

    // Calculate time range
    const now = moment();
    const endTimeMs = now.valueOf();
    const startTimeMs = now.subtract(days, 'days').valueOf();

    // Check database for existing data
    let dbData: Array<[number, number]> = [];
    if (this.historicalPriceService) {
      try {
        dbData = await this.historicalPriceService.getHistoricalPriceData(
          coinId,
          vsCurrency,
          startTimeMs,
          endTimeMs,
        );
        this.logger.debug(
          `Found ${dbData.length} price points in database for ${coinId} (${vsCurrency}, ${days}d)`,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to query database for historical prices:`,
          error,
        );
      }
    }

    // Determine if we need to fetch from CoinGecko
    const isRecentData = days <= 7;
    let needsFetch = false;
    let fetchDays = days;
    let fetchStartTime = startTimeMs;

    if (isRecentData && this.historicalPriceService) {
      try {
        const latestTimestamp =
          await this.historicalPriceService.getLatestTimestamp(
            coinId,
            vsCurrency,
          );

        if (latestTimestamp === null) {
          needsFetch = true;
        } else if (latestTimestamp < endTimeMs - 3600000) {
          needsFetch = true;
          const hoursSinceLatest =
            (endTimeMs - latestTimestamp) / (1000 * 60 * 60);
          fetchDays = Math.ceil(hoursSinceLatest / 24);
          fetchStartTime = latestTimestamp + 1;
        }
      } catch (error) {
        this.logger.warn(`Failed to check latest timestamp:`, error);
        needsFetch = true;
      }
    } else {
      if (this.historicalPriceService) {
        try {
          const missingRanges =
            await this.historicalPriceService.getMissingDataRanges(
              coinId,
              vsCurrency,
              startTimeMs,
              endTimeMs,
            );

          if (missingRanges.length > 0) {
            needsFetch = true;
            const largestRange = missingRanges.reduce((prev, curr) => {
              const prevSize = prev[1] - prev[0];
              const currSize = curr[1] - curr[0];
              return currSize > prevSize ? curr : prev;
            });
            fetchStartTime = largestRange[0];
            const fetchEndTime = largestRange[1];
            fetchDays = Math.ceil(
              (fetchEndTime - fetchStartTime) / (1000 * 60 * 60 * 24),
            );
          }
        } catch (error) {
          this.logger.warn(`Failed to check missing data ranges:`, error);
          needsFetch = true;
        }
      } else {
        needsFetch = true;
      }
    }

    // If we have complete data from database, return it
    if (!needsFetch && dbData.length > 0) {
      this.logger.log(
        `Using complete historical data from database: ${dbData.length} price points`,
      );
      try {
        await this.cacheManager.set(cacheKey, dbData, 3600 * 1000);
      } catch (error) {
        this.logger.warn(`Cache write error:`, error);
      }
      return dbData;
    }

    // Fetch missing data from CoinGecko
    let newData: Array<[number, number]> = [];
    if (needsFetch) {
      try {
        const searchParams: Record<string, string> = {
          vs_currency: vsCurrency,
          days: String(fetchDays),
        };

        if (interval) {
          searchParams.interval = interval;
        }

        this.logger.log(
          `Fetching ${fetchDays} days of historical data from CoinGecko (${isRecentData ? 'incremental' : 'full range'})`,
        );

        const response = (await this.fetchFromApi(
          `/coins/${coinId}/market_chart`,
          searchParams,
        )) as {
          prices?: [number, number][];
          status?: { error_code: number; error_message: string };
        };

        if (response?.status?.error_code) {
          if (response.status.error_code === 429) {
            this.logger.warn(
              `CoinGecko rate limit hit (429). Using database data if available, or falling back to JSON file.`,
            );
            if (dbData.length > 0) {
              return dbData;
            }
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
            return this.readFallbackPriceData();
          }
          this.logger.error(
            `CoinGecko API error: ${response.status.error_code} - ${response.status.error_message}. Using database data if available.`,
          );
          if (dbData.length > 0) {
            return dbData;
          }
          return this.readFallbackPriceData();
        }

        const prices = response?.prices || null;

        if (prices && prices.length > 0) {
          newData = prices.filter(
            ([timestamp]) =>
              timestamp >= fetchStartTime && timestamp <= endTimeMs,
          );

          if (newData.length > 0) {
            const firstPrice = newData[0];
            const lastPrice = newData[newData.length - 1];
            this.logger.log(
              `CoinGecko returned ${newData.length} new price points. First: ${moment(firstPrice[0]).toISOString()} = ${firstPrice[1]} ${vsCurrency}, Last: ${moment(lastPrice[0]).toISOString()} = ${lastPrice[1]} ${vsCurrency}`,
            );
          }

          if (this.historicalPriceService && newData.length > 0) {
            try {
              await this.historicalPriceService.savePriceData(
                coinId,
                vsCurrency,
                newData,
              );
            } catch (error) {
              this.logger.error(
                `Failed to save price data to database:`,
                error,
              );
            }
          }
        } else {
          this.logger.warn(
            `CoinGecko returned empty or invalid price data for ${coinId}. Using database data if available.`,
          );
          if (dbData.length > 0) {
            return dbData;
          }
          return this.readFallbackPriceData();
        }
      } catch (error) {
        this.logger.warn(
          `Failed to fetch historical price from CoinGecko:`,
          error,
        );
        if (dbData.length > 0) {
          this.logger.log('Using database data due to CoinGecko fetch failure');
          return dbData;
        }
        this.logger.log('Falling back to JSON file data');
        return this.readFallbackPriceData();
      }
    }

    // Merge database data with newly fetched data
    let mergedData: Array<[number, number]> = [];
    if (this.historicalPriceService) {
      mergedData = this.historicalPriceService.mergePriceData(dbData, newData);
    } else {
      mergedData = newData;
    }

    // Filter to requested time range
    mergedData = mergedData.filter(
      ([timestamp]) => timestamp >= startTimeMs && timestamp <= endTimeMs,
    );

    if (mergedData.length > 0) {
      try {
        await this.cacheManager.set(cacheKey, mergedData, 3600 * 1000);
        this.logger.debug(
          `Cached merged historical price data: ${mergedData.length} price points`,
        );
      } catch (error) {
        this.logger.warn(`Cache write error:`, error);
      }
    }

    return mergedData.length > 0 ? mergedData : this.readFallbackPriceData();
  }
}
