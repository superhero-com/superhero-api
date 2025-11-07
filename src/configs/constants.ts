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

/**
 * Popular posts ranking configuration (v1)
 */
export const POPULAR_RANKING_CONFIG = {
  // default time windows (hours)
  WINDOW_24H_HOURS: 24,
  WINDOW_7D_HOURS: 24 * 7,

  // weights
  WEIGHTS: {
    comments: 1.7, // w_c (↑ more important)
    tipsAmountAE: 4.0, // w_ta (↑ most important)
    tipsCount: 1, // w_tc (supporting)
    interactionsPerHour: 0.2, // w_it (minor)
    trendingBoost: 0.4, // w_tr (minor)
    contentQuality: 0.3, // w_q (minor, prevents spam)
    accountBalance: 0.2, // w_bal (very minor)
    accountAge: 0.02, // w_age (very minor)
    invites: 2, // w_inv (supporting reputation)
    ownedTrends: 1.5, // w_owned (↑ important among account signals)
    reads: 1.0, // w_reads (modest influence)
  },

  // time decay
  GRAVITY: 1.6, // 24h
  GRAVITY_7D: 1.0,
  T_BIAS: 1.0,

  // content quality params
  CONTENT: {
    minLengthForNoPenalty: 10,
    maxReferenceLength: 140,
    highEmojiRatioThreshold: 0.5,
    shortLengthThreshold: 10,
  },

  // trending scaling
  TRENDING_MAX_SCORE: 100, // scale trending tag score to [0..1]

  // redis
  REDIS_KEYS: {
    popular24h: 'popular:24h',
    popular7d: 'popular:7d',
    popularAll: 'popular:all',
  },
  REDIS_TTL_SECONDS: 120,

  // owned trends normalization
  OWNED_TRENDS_MAX_TRENDING_SCORE: 100,
  OWNED_TRENDS_LOG_NORMALIZER: 10_000, // legacy (score-based)
  OWNED_TRENDS_VALUE_CURRENCY: 'ae' as 'ae' | 'usd', // controls owned-trends currency basis
  OWNED_TRENDS_VALUE_NORMALIZER_AE: 20000, // 20k AE portfolio ~ full score
  OWNED_TRENDS_VALUE_NORMALIZER_USD: 500000, // $500k portfolio ~ full score

  // AE balance normalization (account balance factor)
  BALANCE_NORMALIZER_AE: 500_000, // 0.5M AE ~ full score
  BALANCE_CACHE_TTL_SECONDS: 600, // 10 minutes
  // Bot UA denylist (lowercase substrings)
  BOT_UA_DENYLIST: [
    'bot',
    'spider',
    'crawler',
    'preview',
    'uptime',
    'monitor',
    'curl',
  ],
  // score floors to hide zero-signal posts
  SCORE_FLOOR_DEFAULT: 0.01, // 24h
  SCORE_FLOOR_7D: 0.008, // 7d
  SCORE_FLOOR_ALL: 0.1, // all-time

  // candidate caps
  MAX_CANDIDATES_24H: 500,
  MAX_CANDIDATES_7D: 3000,
  MAX_CANDIDATES_ALL: 10000,
} as const;
