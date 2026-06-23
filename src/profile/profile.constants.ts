/**
 * Master kill-switch for every profile reward payout (X posting reward, X
 * invite milestone reward, …). It hard-overrides every per-reward `*_ENABLED`
 * toggle below, so nothing pays out while this is true even if those env vars
 * are set.
 *
 * Defaults to DISABLED (`true`) for safety; set `PROFILE_REWARDS_DISABLED=false`
 * in the environment to actually arm reward payouts. Enabling this spends real
 * AE from the configured reward wallets — only do so once the reward program is
 * decided and the wallets are funded.
 */
export const PROFILE_REWARDS_DISABLED: boolean =
  (process.env.PROFILE_REWARDS_DISABLED || 'true').trim().toLowerCase() !==
  'false';

export const PROFILE_X_POSTING_REWARD_AMOUNT_AE =
  process.env.PROFILE_X_POSTING_REWARD_AMOUNT_AE || '0.05';

export const PROFILE_X_POSTING_REWARD_ENABLED =
  !PROFILE_REWARDS_DISABLED &&
  (process.env.PROFILE_X_POSTING_REWARD_ENABLED || 'false')
    .trim()
    .toLowerCase() !== 'false';

export const PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS = parseInt(
  process.env.PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS || '30',
  10,
);

export const PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS = parseInt(
  process.env.PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS || '3600',
  10,
);

export const PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS = parseInt(
  process.env.PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS || '5000',
  10,
);

export const PROFILE_X_POSTING_REWARD_ENABLE_POST_FETCH =
  (process.env.PROFILE_X_POSTING_REWARD_ENABLE_POST_FETCH || 'false')
    .trim()
    .toLowerCase() !== 'false';

export const PROFILE_X_POSTING_REWARD_KEYWORDS = [
  'superhero.com',
  'superhero_chain',
];

export const PROFILE_X_INVITE_MILESTONE_THRESHOLD = parseInt(
  process.env.PROFILE_X_INVITE_MILESTONE_THRESHOLD || '10',
  10,
);

export const PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE =
  process.env.PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE || '0';

export const PROFILE_X_INVITE_MILESTONE_REWARD_PRIVATE_KEY =
  process.env.PROFILE_X_INVITE_MILESTONE_REWARD_PRIVATE_KEY || '';

export const PROFILE_X_INVITE_LINK_BASE_URL =
  process.env.PROFILE_X_INVITE_LINK_BASE_URL || '';

export const PROFILE_X_INVITE_CHALLENGE_TTL_SECONDS = 300;

export const PROFILE_X_INVITE_PENDING_TIMEOUT_SECONDS = 300;

/** Sponsored claims only accept labels of at least this length (without `.chain`). */
export const PROFILE_CHAIN_NAME_MIN_LABEL_LENGTH = 13;

export const PROFILE_CHAIN_NAME_PRIVATE_KEY =
  process.env.PROFILE_CHAIN_NAME_PRIVATE_KEY || '';

export const PROFILE_CHAIN_NAME_CHALLENGE_TTL_SECONDS = 300;

export const PROFILE_CHAIN_NAME_RETRY_BASE_SECONDS = parseInt(
  process.env.PROFILE_CHAIN_NAME_RETRY_BASE_SECONDS || '30',
  10,
);

export const PROFILE_CHAIN_NAME_RETRY_MAX_SECONDS = parseInt(
  process.env.PROFILE_CHAIN_NAME_RETRY_MAX_SECONDS || '3600',
  10,
);

export const PROFILE_CHAIN_NAME_MAX_RETRIES = 10;

/* -------------------------------------------------------------------------- */
/* X reward program v2 (referral links, per-post rewards, streak bonus)        */
/* -------------------------------------------------------------------------- */

/**
 * Hard cap on how often a single address may trigger a (paid) X API read
 * cycle. Enforced atomically in the DB so retries / restarts / concurrent
 * requests cannot deplete the X API budget. Falls back to 24h on bad input.
 */
export const PROFILE_X_REWARD_DAILY_CAP_HOURS = (() => {
  const parsed = parseInt(
    process.env.PROFILE_X_REWARD_DAILY_CAP_HOURS || '24',
    10,
  );
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 24;
})();

/** Base URL used to build a user's unique referral link (`<base>?ref=<code>`). */
export const PROFILE_X_REFERRAL_LINK_BASE_URL = 'https://superhero.com';

/**
 * Minimum X follower count required to participate in the reward program.
 * Accounts below this never accrue qualifying posts, per-post rewards or
 * streak progress (already-accrued payouts still settle). Falls back to 100.
 */
export const PROFILE_X_REWARD_MIN_FOLLOWERS = (() => {
  const parsed = parseInt(
    process.env.PROFILE_X_REWARD_MIN_FOLLOWERS || '100',
    10,
  );
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 100;
})();

/* --- Path 1: onboarding (verify X + 1 keyword post → one-time reward) ------ */

export const PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE =
  process.env.PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE ||
  PROFILE_X_POSTING_REWARD_AMOUNT_AE;

export const PROFILE_X_ONBOARDING_THRESHOLD = 1;

export const PROFILE_X_ONBOARDING_REWARD_PRIVATE_KEY =
  process.env.PROFILE_X_ONBOARDING_REWARD_PRIVATE_KEY || '';

export const PROFILE_X_ONBOARDING_REWARD_ENABLED =
  !PROFILE_REWARDS_DISABLED &&
  (process.env.PROFILE_X_ONBOARDING_REWARD_ENABLED || 'false')
    .trim()
    .toLowerCase() !== 'false';

/* --- Path 2: per-post rewards (referral link post → follower-tiered AE) ----- */

export const PROFILE_X_PERPOST_REWARD_PRIVATE_KEY =
  process.env.PROFILE_X_PERPOST_REWARD_PRIVATE_KEY || '';

export const PROFILE_X_PERPOST_REWARD_ENABLED =
  !PROFILE_REWARDS_DISABLED &&
  (process.env.PROFILE_X_PERPOST_REWARD_ENABLED || 'false')
    .trim()
    .toLowerCase() !== 'false';

/* --- Streak bonus (every N consecutive posting days → recurring bonus) ------ */

export const PROFILE_X_REWARD_STREAK_LENGTH = (() => {
  const parsed = parseInt(
    process.env.PROFILE_X_REWARD_STREAK_LENGTH || '10',
    10,
  );
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 10;
})();

export const PROFILE_X_REWARD_STREAK_BONUS_AMOUNT_AE =
  process.env.PROFILE_X_REWARD_STREAK_BONUS_AMOUNT_AE || '50';

export const PROFILE_X_REWARD_STREAK_BONUS_PRIVATE_KEY =
  process.env.PROFILE_X_REWARD_STREAK_BONUS_PRIVATE_KEY || '';

export const PROFILE_X_REWARD_STREAK_BONUS_ENABLED =
  !PROFILE_REWARDS_DISABLED &&
  (process.env.PROFILE_X_REWARD_STREAK_BONUS_ENABLED || 'false')
    .trim()
    .toLowerCase() !== 'false';

/* --- Follower tier table (follower-count ranges → per-post AE amount) ------- */

export type FollowerTier = {
  /** Inclusive lower bound of follower count for this tier. */
  minFollowers: number;
  /** Per-post reward amount in AE (validated > 0). */
  amountAe: string;
  /** Stable index into the ascending tier list (0 = lowest tier). */
  index: number;
};

const AE_AMOUNT_REGEX = /^\d+(\.\d+)?$/;

/**
 * Parse `"0:0.1,1000:0.5,10000:1"` into an ascending tier list. Invalid entries
 * (bad number, non-positive amount, negative threshold) are dropped.
 */
export const PROFILE_X_FOLLOWER_TIERS: FollowerTier[] = (
  process.env.PROFILE_X_FOLLOWER_TIERS || '0:0.1,1000:0.5,10000:1,100000:5'
)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const separatorIndex = entry.indexOf(':');
    if (separatorIndex <= 0) {
      return null;
    }
    const minFollowers = Number(entry.slice(0, separatorIndex).trim());
    const amountAe = entry.slice(separatorIndex + 1).trim();
    if (
      !Number.isInteger(minFollowers) ||
      minFollowers < 0 ||
      !AE_AMOUNT_REGEX.test(amountAe) ||
      Number(amountAe) <= 0
    ) {
      return null;
    }
    return { minFollowers, amountAe };
  })
  .filter((tier): tier is { minFollowers: number; amountAe: string } => !!tier)
  .sort((a, b) => a.minFollowers - b.minFollowers)
  .map((tier, index) => ({ ...tier, index }));
