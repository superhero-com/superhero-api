export const SOCIAL_GRAPH_PLUGIN_NAME = 'social-graph';

/**
 * The deployed SocialContract address. Provisional by nature — a redeploy (any
 * change to the contract source) mints a new address — so it MUST be a config
 * value and is never hardcoded. The plugin disables itself when this is unset.
 */
export const SOCIAL_GRAPH_CONTRACT_ADDRESS =
  process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS || '';

/**
 * The one predicate for "is the social graph configured". Everything that gates
 * on the switch — the contract service, the profile counts, the controller
 * guard — reads this, so the feature is enabled or disabled in exactly one
 * place.
 */
export const SOCIAL_GRAPH_ENABLED = Boolean(SOCIAL_GRAPH_CONTRACT_ADDRESS);

/**
 * The block height the configured contract was deployed at. Config for the same
 * reason the address is: a redeploy moves both, and a start height left behind
 * an address that moved is how a plugin silently indexes from the wrong block
 * and fails as a plausible-looking count rather than an error. Defaults to the
 * recorded testnet deploy height.
 */
export const SOCIAL_GRAPH_START_HEIGHT = Number(
  process.env.SOCIAL_GRAPH_START_HEIGHT || 1283835,
);

/**
 * Expected init() triple. The boot assertion reads get_config() from the
 * configured contract and refuses to start unless it returns exactly this
 * triple — turning "the API is quietly pointed at the wrong contract" into a
 * loud failure on first boot instead of weeks of plausible, wrong counts.
 * Overridable so a future redeploy with different caps needs a config change,
 * not a code change.
 */
export const SOCIAL_GRAPH_EXPECTED_MAX_FOLLOWING = Number(
  process.env.SOCIAL_GRAPH_EXPECTED_MAX_FOLLOWING || 10000,
);
export const SOCIAL_GRAPH_EXPECTED_MAX_BLOCKED = Number(
  process.env.SOCIAL_GRAPH_EXPECTED_MAX_BLOCKED || 10000,
);
export const SOCIAL_GRAPH_EXPECTED_FOLLOW_COOLDOWN = Number(
  process.env.SOCIAL_GRAPH_EXPECTED_FOLLOW_COOLDOWN || 0,
);
