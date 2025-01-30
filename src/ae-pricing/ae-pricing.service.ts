import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import { CoinGeckoService } from 'src/ae/coin-gecko.service';
import { AETERNITY_COIN_ID, CURRENCIES } from 'src/configs';
import { IPriceDto } from 'src/tokens/dto/price.dto';
import { Repository } from 'typeorm';
import { CoinPrice } from './entities/coin-price.entity';

@Injectable()
export class AePricingService {
  latestRates: CoinPrice | null = null;

  constructor(
    public coinGeckoService: CoinGeckoService,
    @InjectRepository(CoinPrice)
    private coinPriceRepository: Repository<CoinPrice>,
  ) {}

  async pullAndSaveCoinCurrencyRates() {
    const rates =
      await this.coinGeckoService.fetchCoinCurrencyRates(AETERNITY_COIN_ID);
    if (!rates) {
      return this.latestRates;
    }
    this.latestRates = await this.coinPriceRepository.save({
      rates,
    });
    console.log('latestRates::', this.latestRates);
    return this.latestRates;
  }

  /**
   * Retrieves the price data for a given amount of AE tokens.
   * @param price - The amount of AE tokens.
   * @returns An object containing the price data for AE and other currencies.
   */
  async getPriceData(price: BigNumber): Promise<IPriceDto> {
    let latestRates = null;
    try {
      latestRates = await this.coinPriceRepository.findOne({
        where: {},
        order: {
          created_at: 'DESC',
        },
      });
    } catch (error) {
      //
    }
    if (!latestRates) {
      latestRates = await this.pullAndSaveCoinCurrencyRates();
    }

    const prices = {
      ae: price,
    };

    if (!this.latestRates) {
      return prices as any;
    }

    CURRENCIES.forEach(({ code }) => {
      try {
        prices[code] = price.multipliedBy(this.latestRates.rates![code]) as any;
      } catch (error) {
        // console.warn(`Failed to calculate price for ${code}`);
        prices[code] = null;
      }
    });

    return prices as any;
  }
}
