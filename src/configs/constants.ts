import type { CurrencyCode, ICurrency, IToken } from '../ae/utils/types';

export const AETERNITY_CONTRACT_ID = 'aeternity';
export const AETERNITY_SYMBOL = 'AE';
export const AETERNITY_COIN_ID = 'aeternity';
export const AETERNITY_COIN_SYMBOL = 'AE Coin';
export const AETERNITY_COIN_NAME = 'Aeternity';
export const AETERNITY_COIN_PRECISION = 18; // Amount of decimals

export const AETERNITY_TOKEN_BASE_DATA: Partial<IToken> = {
  address: AETERNITY_CONTRACT_ID,
  decimals: AETERNITY_COIN_PRECISION,
  name: AETERNITY_COIN_NAME,
  symbol: AETERNITY_SYMBOL,
};

export const AE_SYMBOL = 'AE';

export const DEFAULT_CURRENCY_CODE: CurrencyCode = 'usd';

export const CURRENCIES: ICurrency[] = [
  {
    name: 'United States Dollar',
    code: 'usd',
    symbol: '$',
  },
  {
    name: 'Euro',
    code: 'eur',
    symbol: '€',
  },
  {
    name: 'Australia Dollar',
    code: 'aud',
    symbol: 'AU$',
  },
  {
    name: 'Brasil Real',
    code: 'brl',
    symbol: 'R$',
  },
  {
    name: 'Canada Dollar',
    code: 'cad',
    symbol: 'CA$',
  },
  {
    name: 'Swiss Franc',
    code: 'chf',
    symbol: 'CHF',
  },
  {
    name: 'United Kingdom Pound',
    code: 'gbp',
    symbol: '£',
  },
  {
    name: 'Gold Ounce',
    code: 'xau',
    symbol: 'XAU',
  },
];

export const WEB_SOCKET_CHANNELS = {
  Transactions: 'Transactions',
  MicroBlocks: 'MicroBlocks',
  KeyBlocks: 'KeyBlocks',
  Object: 'Object',
};

export const WEB_SOCKET_SOURCE = {
  mdw: 'mdw',
  node: 'node',
};

export const WEB_SOCKET_SUBSCRIBE = 'Subscribe';
export const WEB_SOCKET_UNSUBSCRIBE = 'Unsubscribe';
export const WEB_SOCKET_RECONNECT_TIMEOUT = 20000;

export const TX_FUNCTIONS = {
  buy: 'buy',
  sell: 'sell',
  create_community: 'create_community',
} as const;
