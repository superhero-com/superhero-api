import type { CurrencyCode, ICurrency, IToken } from '@/utils/types';

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

export const BCL_FUNCTIONS = {
  buy: 'buy',
  sell: 'sell',
  create_community: 'create_community',
};

export const TX_FUNCTIONS = {
  ...BCL_FUNCTIONS,

  // dex(swap)
  swap_exact_tokens_for_tokens: 'swap_exact_tokens_for_tokens',
  swap_tokens_for_exact_tokens: 'swap_tokens_for_exact_tokens',
  swap_exact_ae_for_tokens: 'swap_exact_ae_for_tokens',
  swap_exact_tokens_for_ae: 'swap_exact_tokens_for_ae',
  swap_tokens_for_exact_ae: 'swap_tokens_for_exact_ae',
  swap_ae_for_exact_tokens: 'swap_ae_for_exact_tokens',

  add_liquidity: 'add_liquidity',
  add_liquidity_ae: 'add_liquidity_ae',
  remove_liquidity_ae: 'remove_liquidity_ae',
  remove_liquidity: 'remove_liquidity',
} as const;

export const WAIT_TIME_WHEN_REQUEST_FAILED = 3000; // 3 seconds
export const MAX_RETRIES_WHEN_REQUEST_FAILED = 3;

/**
 * sync config
 */
export const TOTAL_BLOCKS_TO_SYNC_EVERY_MINUTE = 10;
export const TOTAL_BLOCKS_TO_SYNC_EVERY_10_MINUTES = 100;

export const TOTAL_BLOCKS_TO_HAVE_STABLE_DATA = 100;

export const FIX_FAILED_TRANSACTION_WHEN_BLOCK_HEIGHT_IS_LESS_THAN = 10;
export const MAX_RETRIES_FOR_FAILED_TRANSACTIONS = 10;

export const MAX_TOKENS_TO_CHECK_WITHOUT_HOLDERS = 20;

export const SYNCING_ENABLED = false;
export const LIVE_SYNCING_ENABLED = false;
export const PERIODIC_SYNCING_ENABLED = false;
export const UPDATE_TRENDING_TOKENS_ENABLED = false;
export const PULL_INVITATIONS_ENABLED = false;
export const PULL_ACCOUNTS_ENABLED = false;
export const PULL_TRENDING_TAGS_ENABLED = false;
export const PULL_SOCIAL_POSTS_ENABLED = false;
export const PULL_DEX_TOKENS_ENABLED = false;
export const PULL_DEX_PAIRS_ENABLED = false;

/**
 * API Keys and Security
 */
export const TRENDING_TAGS_API_KEY =
  process.env.TRENDING_TAGS_API_KEY || 'your-secret-key-here-xxrf8ca2929';

/**
 * Trending Score Configuration
 */
export const TRENDING_SCORE_CONFIG = {
  // Weights for trending score calculation
  TRANSACTION_WEIGHT: 0.6, // w1 - weight for unique transactions in 24h
  VOLUME_WEIGHT: 0.4, // w2 - weight for investment velocity

  // Time window for trending calculations
  TIME_WINDOW_HOURS: 24,
  MAX_LIFETIME_MINUTES: 1440, // 24 hours in minutes
} as const;
