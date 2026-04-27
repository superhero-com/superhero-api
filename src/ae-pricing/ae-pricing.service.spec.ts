import { CURRENCIES } from '@/configs';
import { CurrencyRates } from '@/utils/types';
import BigNumber from 'bignumber.js';
import { AePricingService } from './ae-pricing.service';

const buildCompleteRates = (
  overrides: Partial<CurrencyRates> = {},
): CurrencyRates =>
  ({
    ...Object.fromEntries(
      CURRENCIES.map(({ code }, index) => [code, (index + 1) / 100]),
    ),
    ...overrides,
  }) as CurrencyRates;

describe('AePricingService', () => {
  let service: AePricingService;
  let coinGeckoService: { getAeternityRates: jest.Mock };
  let coinPriceRepository: { query: jest.Mock; save: jest.Mock };

  beforeEach(() => {
    coinGeckoService = {
      getAeternityRates: jest.fn(),
    };
    coinPriceRepository = {
      query: jest.fn(),
      save: jest.fn(),
    };
    service = new AePricingService(
      coinGeckoService as any,
      coinPriceRepository as any,
    );
  });

  it('should return complete CoinGecko rates', async () => {
    const rates = buildCompleteRates({ usd: 0.1 });
    coinGeckoService.getAeternityRates.mockResolvedValue(rates);

    await expect(service.getCurrencyRates()).resolves.toEqual(rates);
    expect(coinPriceRepository.query).not.toHaveBeenCalled();
  });

  it('should fall back to latest complete DB rates', async () => {
    const olderCompleteRates = buildCompleteRates({ usd: 0.1 });
    coinGeckoService.getAeternityRates.mockRejectedValue(
      new Error('cache miss'),
    );
    coinPriceRepository.query.mockResolvedValue([
      {
        id: 1,
        rates: olderCompleteRates,
        created_at: new Date('2026-04-27T00:00:00Z'),
      },
    ]);

    await expect(service.getCurrencyRates()).resolves.toEqual(
      olderCompleteRates,
    );
    expect(coinPriceRepository.query).toHaveBeenCalledWith(
      expect.stringContaining('rates::jsonb ?& $1::text[]'),
      [CURRENCIES.map(({ code }) => code)],
    );
  });

  it('should rely on the DB to skip any number of incomplete newer snapshots', async () => {
    const completeRates = buildCompleteRates({ usd: 0.1 });
    coinGeckoService.getAeternityRates.mockRejectedValue(
      new Error('cache miss'),
    );
    coinPriceRepository.query.mockResolvedValue([
      {
        id: 1,
        rates: completeRates,
        created_at: new Date('2026-04-26T00:00:00Z'),
      },
    ]);

    await expect(service.getCurrencyRates()).resolves.toEqual(completeRates);
    const [sql] = coinPriceRepository.query.mock.calls[0];
    expect(sql).not.toContain('LIMIT 10');
  });

  it('should throw when no complete rates are available', async () => {
    coinGeckoService.getAeternityRates.mockRejectedValue(
      new Error('cache miss'),
    );
    coinPriceRepository.query.mockResolvedValue([
      {
        id: 1,
        rates: { usd: 0.1 },
        created_at: new Date(),
      },
    ]);

    await expect(service.getCurrencyRates()).rejects.toThrow(
      'Aeternity rates are temporarily unavailable',
    );
  });

  it('should not save incomplete rates snapshots', async () => {
    const dbRates = buildCompleteRates({ usd: 0.1 });
    coinGeckoService.getAeternityRates.mockResolvedValue({ usd: 0.2 });
    coinPriceRepository.query.mockResolvedValue([
      {
        id: 1,
        rates: dbRates,
        created_at: new Date(),
      },
    ]);

    const result = await service.pullAndSaveCoinCurrencyRates();

    expect(result?.rates).toEqual(dbRates);
    expect(coinPriceRepository.save).not.toHaveBeenCalled();
  });

  it('should price all supported currencies from the latest DB snapshot', async () => {
    const rates = buildCompleteRates({ usd: 0.1, eur: 0.09 });
    coinPriceRepository.query.mockResolvedValue([
      {
        id: 1,
        rates,
        created_at: new Date(),
      },
    ]);

    const result = await service.getPriceData(new BigNumber(2));

    expect(result.ae).toEqual(new BigNumber(2));
    expect(result.usd).toEqual(new BigNumber(0.2));
    expect(result.eur).toEqual(new BigNumber(0.18));
  });
});
