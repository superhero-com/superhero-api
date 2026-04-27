import { CURRENCIES } from '@/configs';
import { CurrencyRates } from './types';

export function isCompleteCurrencyRates(
  rates: unknown,
): rates is CurrencyRates {
  if (!rates || typeof rates !== 'object') {
    return false;
  }

  return CURRENCIES.every(({ code }) => {
    const rate = (rates as Partial<CurrencyRates>)[code];
    return typeof rate === 'number' && Number.isFinite(rate);
  });
}

export function getMissingCurrencyCodes(
  rates: Partial<CurrencyRates>,
): string[] {
  return CURRENCIES.filter(({ code }) => {
    const rate = rates[code];
    return typeof rate !== 'number' || !Number.isFinite(rate);
  }).map(({ code }) => code);
}
