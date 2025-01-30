import { Injectable } from '@nestjs/common';
import BigNumber from 'bignumber.js';
import moment, { Moment } from 'moment';
import { AETERNITY_COIN_ID, CURRENCIES } from 'src/configs';
import { IPriceDto } from 'src/tokens/dto/price.dto';
import { fetchJson } from './utils/common';
import { CurrencyRates } from './utils/types';

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
  rates: CurrencyRates | null = null;
  last_pull_time: Moment;

  /**
   * CoinGeckoService class responsible for pulling data at regular intervals.
   */
  constructor() {
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
        prices[code] = price.multipliedBy(this.rates![code]) as any;
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
}
