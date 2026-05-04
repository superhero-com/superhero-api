import type { CurrencyCode, ICurrency, IToken } from '@/utils/types';

export const AETERNITY_CONTRACT_ID = 'aeternity';
export const AETERNITY_SYMBOL = 'AE';
export const AETERNITY_COIN_ID = 'aeternity';
export const AETERNITY_COIN_SYMBOL = 'AE Coin';
export const AETERNITY_COIN_NAME = 'Aeternity';
export const AETERNITY_COIN_PRECISION = 18; // Amount of decimals

/**
 * Supported cryptocurrency coins for pricing endpoints
 * Maps coin identifier (used in API path) to CoinGecko coin ID
 * Currently only aeternity is supported, but this can be extended to support multiple coins
 */
export const SUPPORTED_COINS: Record<string, string> = {
  aeternity: 'aeternity',
} as const;

export const DEFAULT_COIN_ID = 'aeternity';

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

// Note: Old sync constants removed - syncing is now handled by MDW sync system + plugins
// SYNCING_ENABLED - replaced by IndexerService
// LIVE_SYNCING_ENABLED - replaced by LiveIndexerService
// PERIODIC_SYNCING_ENABLED - replaced by IndexerService + BlockValidationService
// PULL_INVITATIONS_ENABLED - replaced by BclAffiliationPlugin
// PULL_SOCIAL_POSTS_ENABLED - replaced by SocialPlugin
// PULL_DEX_TOKENS_ENABLED - unused
// PULL_DEX_PAIRS_ENABLED - unused

// Analytics/calculation jobs (not transaction syncing):
export const UPDATE_TRENDING_TOKENS_ENABLED = true;
export const PULL_ACCOUNTS_ENABLED = false;
export const PULL_TRENDING_TAGS_ENABLED = false;

/**
 * API Keys and Security
 */
export const TRENDING_TAGS_API_KEY =
  process.env.TRENDING_TAGS_API_KEY || 'your-secret-key-here-xxrf8ca2929';

/**
 * Trending Score Configuration
 */
export const TRENDING_SCORE_CONFIG = {
  WINDOW_HOURS: 24,
  ACTIVE_REFRESH_CRON: '0 */2 * * *',
  STALE_BACKFILL_CRON: '30 */6 * * *',
  ELIGIBILITY_COUNTS_REFRESH_CRON: '15 */2 * * *',
  // Keep the active lookback aligned with the 2-hour refresh cadence so
  // scheduled runs do not skip most of the activity window.
  ACTIVITY_LOOKBACK_MINUTES: 120,
  MAX_ACTIVE_BATCH: 250,
  MAX_STALE_BATCH: 150,
  MAX_CONCURRENT_UPDATES: 8,
  STALE_AFTER_MINUTES: 30,

  // Trading remains important, but community activity should dominate ranking.
  GROUP_WEIGHTS: {
    trading: 0.35,
    social: 0.65,
  },

  TRADING_WEIGHTS: {
    activeWallets: 0.4,
    buyCount: 0.2,
    sellCount: 0.2,
    volumeAe: 0.2,
  },

  SOCIAL_WEIGHTS: {
    mentionPosts: 0.32,
    mentionComments: 0.32,
    uniqueAuthors: 0.22,
    tipsCount: 0.05,
    tipsAmountAe: 0.03,
    reads: 0.06,
  },

  CAPS: {
    activeWallets: 25,
    buyCount: 40,
    sellCount: 40,
    volumeAe: 5000,
    mentionPosts: 15,
    mentionComments: 50,
    uniqueAuthors: 20,
    tipsCount: 15,
    tipsAmountAe: 250,
    reads: 200,
  },

  DECAY: {
    biasHours: 2,
    gravity: 1.15,
  },
} as const;

export const TOKEN_LIST_ELIGIBILITY_CONFIG = {
  MIN_HOLDERS: 5,
  MIN_TOKEN_POSTS_ALL_TIME: 2,
  MIN_TRADES_ALL_TIME: 3,
} as const;

export const POPULAR_RANKING_WEIGHT_SCALES = ['low', 'med', 'high'] as const;
export type PopularRankingWeightScale =
  (typeof POPULAR_RANKING_WEIGHT_SCALES)[number];

/**
 * Popular posts ranking configuration — all-time "Top" style with a short
 * freshness boost so low-activity feeds still feel alive.
 */
export const POPULAR_RANKING_CONFIG = {
  // time windows (hours)
  WINDOW_24H_HOURS: 24,
  WINDOW_7D_HOURS: 24 * 7,

  // weights — tipping is rare so comments and reads lead
  WEIGHTS: {
    comments: 2.5, // w_c (primary engagement signal)
    tipsAmountAE: 1.5, // w_ta (meaningful but not dominant since tipping is rare)
    tipsCount: 1.0, // w_tc (total tip actions)
    uniqueTippers: 1.5, // w_ut (breadth of support — many tippers > one whale)
    trendingBoost: 0.5, // w_tr (topical relevance)
    contentQuality: 0.3, // w_q (anti-spam)
    reads: 1.5, // w_reads (common passive signal)
    freshnessBoost: 1.5, // w_fresh (temporary new-post lift)
    velocityBoost: 0.6, // w_vel (temporary lift for posts gaining activity quickly)
  },

  // user-facing scale controls tune relative importance instead of exposing raw weights
  CUSTOMIZATION: {
    SCALE_MULTIPLIERS: {
      low: 0.6,
      med: 1,
      high: 1.5,
    },
    ADDITIONAL_SIGNAL_WEIGHTS: {
      interactionsPerHour: 1.1,
    },
  },

  // content quality params
  CONTENT: {
    minLengthForNoPenalty: 10,
    maxReferenceLength: 140,
    highEmojiRatioThreshold: 0.5,
    shortLengthThreshold: 10,
  },

  // trending scaling
  TRENDING_MAX_SCORE: 100, // scale trending tag score to [0..1]

  // live popular behavior
  FRESHNESS_BOOST_HOURS: 24,
  AUTHOR_DIVERSITY: {
    ENABLED: true,
    OVERSAMPLE_MULTIPLIER: 4,
    MIN_OVERSAMPLE: 80,
  },

  // redis
  REDIS_KEYS: {
    popular24h: 'popular:24h',
    popular7d: 'popular:7d',
    popularAll: 'popular:all',
  },
  REDIS_TTL_SECONDS: 30,

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

  // candidate caps
  MAX_CANDIDATES_24H: 500,
  MAX_CANDIDATES_7D: 3000,
  MAX_CANDIDATES_ALL: 10000,
} as const;
