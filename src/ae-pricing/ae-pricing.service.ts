import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import { CoinGeckoService } from '@/ae/coin-gecko.service';
import { CURRENCIES } from '@/configs';
import { IPriceDto } from '@/tokens/dto/price.dto';
import { CurrencyRates } from '@/utils/types';
import { isCompleteCurrencyRates } from '@/utils/currency-rates.util';
import { Repository } from 'typeorm';
import { CoinPrice } from './entities/coin-price.entity';

@Injectable()
export class AePricingService {
  latestRates: CoinPrice | null = null;
  private latestRatesFetchedAt = 0;
  private ratesRefreshInFlight: Promise<CoinPrice | null> | null = null;
  private static readonly RATES_SNAPSHOT_TTL_MS = 30_000;

  constructor(
    public coinGeckoService: CoinGeckoService,
    @InjectRepository(CoinPrice)
    private coinPriceRepository: Repository<CoinPrice>,
  ) {}

  async getCurrencyRates(): Promise<CurrencyRates> {
    try {
      const rates = await this.coinGeckoService.getAeternityRates();
      if (isCompleteCurrencyRates(rates)) {
        return rates;
      }
    } catch (_err) {
      // Use the DB snapshot below when the in-memory/Redis cache is unavailable.
    }

    const latestRates = await this.findLatestCompleteRatesSnapshot();
    if (latestRates) {
      this.latestRates = latestRates;
      return latestRates.rates as unknown as CurrencyRates;
    }

    throw new ServiceUnavailableException(
      'Aeternity rates are temporarily unavailable',
    );
  }

  /**
   * Reads the latest rates from the CoinGeckoService in-memory / Redis cache
   * and persists a new snapshot to the coin_prices table.
   * Does NOT call the CoinGecko API directly — syncAllFromApi() (cron) must have
   * already populated the cache before this is called.
   */
  async pullAndSaveCoinCurrencyRates() {
    let rates: Record<string, number> | null = null;
    try {
      rates = await this.coinGeckoService.getAeternityRates();
    } catch (_err) {
      // Rates unavailable — fall back to latest DB row below
    }

    if (!isCompleteCurrencyRates(rates)) {
      this.latestRates = await this.findLatestCompleteRatesSnapshot();
      return this.latestRates;
    }

    try {
      this.latestRates = await this.coinPriceRepository.save({
        rates,
      });
    } catch (error) {
      this.latestRates = await this.findLatestCompleteRatesSnapshot();
    }
    return this.latestRates;
  }

  /**
   * Retrieves the price data for a given amount of AE tokens.
   * Reads from the coin_prices DB table (last saved rates snapshot).
   * If no DB row exists yet, uses in-memory / Redis rates via CoinGeckoService.
   * @param price - The amount of AE tokens.
   * @returns An object containing the price data for AE and other currencies.
   */
  async getPriceData(price: BigNumber): Promise<IPriceDto> {
    const latestRates = this.latestRates;
    const now = Date.now();
    if (
      !latestRates ||
      now - this.latestRatesFetchedAt >= AePricingService.RATES_SNAPSHOT_TTL_MS
    ) {
      await this.refreshLatestRates(now);
    }

    const prices: Record<string, BigNumber | null> = {
      ae: price,
    };

    if (!this.latestRates || !isCompleteCurrencyRates(this.latestRates.rates)) {
      CURRENCIES.forEach(({ code }) => {
        prices[code] = null;
      });
      return prices as any;
    }

    CURRENCIES.forEach(({ code }) => {
      try {
        prices[code] = price.multipliedBy(this.latestRates.rates![code]) as any;
      } catch (error) {
        prices[code] = null;
      }
    });

    return prices as any;
  }

  /**
   * Refreshes the in-memory rates snapshot, coalescing concurrent callers.
   * The first caller on a cold/expired cache starts the DB read; every other
   * caller that arrives while it is in flight awaits the same promise instead
   * of issuing its own query. Without this, a burst of concurrent getPriceData
   * calls (the common case — they fire in Promise.all bundles) would each hit
   * the DB before the memo is populated.
   */
  private async refreshLatestRates(now: number): Promise<CoinPrice | null> {
    if (this.ratesRefreshInFlight) {
      return this.ratesRefreshInFlight;
    }

    const refresh = (async () => {
      let latestRates = await this.findLatestCompleteRatesSnapshot();

      // Populate latestRates from cache if not yet in DB (first startup before cron runs)
      if (!latestRates) {
        latestRates = await this.pullAndSaveCoinCurrencyRates();
      }
      if (latestRates) {
        this.latestRatesFetchedAt = now;
      }
      this.latestRates = latestRates;
      return latestRates;
    })();
    this.ratesRefreshInFlight = refresh;

    try {
      return await refresh;
    } finally {
      this.ratesRefreshInFlight = null;
    }
  }

  private async findLatestCompleteRatesSnapshot(): Promise<CoinPrice | null> {
    try {
      const snapshots = await this.coinPriceRepository.query(
        `
          SELECT *
          FROM coin_prices
          WHERE rates::jsonb ?& $1::text[]
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [CURRENCIES.map(({ code }) => code)],
      );
      const latestSnapshot = snapshots[0] as CoinPrice | undefined;

      return latestSnapshot && isCompleteCurrencyRates(latestSnapshot.rates)
        ? latestSnapshot
        : null;
    } catch (error) {
      return null;
    }
  }
}
