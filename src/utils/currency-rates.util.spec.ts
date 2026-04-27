import { CURRENCIES } from '@/configs';
import { CurrencyRates } from './types';
import {
  getMissingCurrencyCodes,
  isCompleteCurrencyRates,
} from './currency-rates.util';

const buildCompleteRates = (
  overrides: Partial<CurrencyRates> = {},
): CurrencyRates =>
  ({
    ...Object.fromEntries(
      CURRENCIES.map(({ code }, index) => [code, (index + 1) / 100]),
    ),
    ...overrides,
  }) as CurrencyRates;

describe('currency rates utils', () => {
  it('should accept finite numeric rates for every supported currency', () => {
    expect(isCompleteCurrencyRates(buildCompleteRates())).toBe(true);
  });

  it('should reject null and non-object values', () => {
    expect(isCompleteCurrencyRates(null)).toBe(false);
    expect(isCompleteCurrencyRates(undefined)).toBe(false);
    expect(isCompleteCurrencyRates('usd')).toBe(false);
  });

  it('should reject rates missing any supported currency', () => {
    expect(isCompleteCurrencyRates({ usd: 0.1 })).toBe(false);
    expect(getMissingCurrencyCodes({ usd: 0.1 })).toEqual(
      CURRENCIES.filter(({ code }) => code !== 'usd').map(({ code }) => code),
    );
  });

  it('should reject non-finite and non-numeric rates', () => {
    const rates = buildCompleteRates({
      eur: Number.NaN,
      gbp: Number.POSITIVE_INFINITY,
      xau: '0.1' as any,
    });

    expect(isCompleteCurrencyRates(rates)).toBe(false);
    expect(getMissingCurrencyCodes(rates)).toEqual(['eur', 'gbp', 'xau']);
  });
});
