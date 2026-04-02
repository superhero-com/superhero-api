export const PROFILE_REGISTRY_CONTRACT_ADDRESS =
  process.env.PROFILE_REGISTRY_CONTRACT_ADDRESS || '';

export const PROFILE_ATTESTATION_SIGNER_ADDRESS =
  process.env.PROFILE_ATTESTATION_SIGNER_ADDRESS || '';

export const PROFILE_ATTESTATION_PRIVATE_KEY =
  process.env.PROFILE_ATTESTATION_PRIVATE_KEY || '';

export const PROFILE_ATTESTATION_TTL_SECONDS = parseInt(
  process.env.PROFILE_ATTESTATION_TTL_SECONDS || '300',
  10,
);

export const PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE =
  process.env.PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE || '0.01';

export const PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY =
  process.env.PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY ||
  PROFILE_ATTESTATION_PRIVATE_KEY;

export const PROFILE_X_VERIFICATION_MIN_FOLLOWERS = parseInt(
  process.env.PROFILE_X_VERIFICATION_MIN_FOLLOWERS || '50',
  10,
);

export const PROFILE_X_VERIFICATION_REWARD_RETRY_BASE_SECONDS = parseInt(
  process.env.PROFILE_X_VERIFICATION_REWARD_RETRY_BASE_SECONDS || '30',
  10,
);

export const PROFILE_X_VERIFICATION_REWARD_RETRY_MAX_SECONDS = parseInt(
  process.env.PROFILE_X_VERIFICATION_REWARD_RETRY_MAX_SECONDS || '3600',
  10,
);

export const PROFILE_X_VERIFICATION_REWARD_FETCH_TIMEOUT_MS = parseInt(
  process.env.PROFILE_X_VERIFICATION_REWARD_FETCH_TIMEOUT_MS || '5000',
  10,
);

export const PROFILE_X_POSTING_REWARD_AMOUNT_AE =
  process.env.PROFILE_X_POSTING_REWARD_AMOUNT_AE || '0.05';

export const PROFILE_X_POSTING_REWARD_ENABLED =
  (process.env.PROFILE_X_POSTING_REWARD_ENABLED || 'false')
    .trim()
    .toLowerCase() !== 'false';

export const PROFILE_X_POSTING_REWARD_THRESHOLD = parseInt(
  process.env.PROFILE_X_POSTING_REWARD_THRESHOLD || '10',
  10,
);

export const PROFILE_X_POSTING_REWARD_SCAN_INTERVAL_SECONDS = parseInt(
  process.env.PROFILE_X_POSTING_REWARD_SCAN_INTERVAL_SECONDS || '60',
  10,
);

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

export const PROFILE_X_POSTING_REWARD_ENABLE_PERIODIC_RECHECKS =
  (process.env.PROFILE_X_POSTING_REWARD_ENABLE_PERIODIC_RECHECKS || 'false')
    .trim()
    .toLowerCase() !== 'false';

export const PROFILE_X_POSTING_REWARD_MANUAL_RECHECK_COOLDOWN_SECONDS =
  parseInt(
    process.env.PROFILE_X_POSTING_REWARD_MANUAL_RECHECK_COOLDOWN_SECONDS ||
      '3600',
    10,
  );

export const PROFILE_X_POSTING_REWARD_KEYWORDS = (
  process.env.PROFILE_X_POSTING_REWARD_KEYWORDS ||
  'superhero.com,superhero_chain'
)
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

export const PROFILE_X_INVITE_MILESTONE_THRESHOLD = parseInt(
  process.env.PROFILE_X_INVITE_MILESTONE_THRESHOLD || '10',
  10,
);

export const PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE =
  process.env.PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE || '0';

export const PROFILE_X_INVITE_MILESTONE_REWARD_PRIVATE_KEY =
  process.env.PROFILE_X_INVITE_MILESTONE_REWARD_PRIVATE_KEY ||
  PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY;

export const PROFILE_X_INVITE_LINK_BASE_URL =
  process.env.PROFILE_X_INVITE_LINK_BASE_URL || '';

export const PROFILE_X_INVITE_CHALLENGE_TTL_SECONDS = parseInt(
  process.env.PROFILE_X_INVITE_CHALLENGE_TTL_SECONDS || '300',
  10,
);

export const PROFILE_X_INVITE_PENDING_TIMEOUT_SECONDS = parseInt(
  process.env.PROFILE_X_INVITE_PENDING_TIMEOUT_SECONDS || '300',
  10,
);

export const PROFILE_CHAIN_NAME_PRIVATE_KEY =
  process.env.PROFILE_CHAIN_NAME_PRIVATE_KEY || '';

export const PROFILE_CHAIN_NAME_CHALLENGE_TTL_SECONDS = parseInt(
  process.env.PROFILE_CHAIN_NAME_CHALLENGE_TTL_SECONDS || '300',
  10,
);

export const PROFILE_CHAIN_NAME_RETRY_BASE_SECONDS = parseInt(
  process.env.PROFILE_CHAIN_NAME_RETRY_BASE_SECONDS || '30',
  10,
);

export const PROFILE_CHAIN_NAME_RETRY_MAX_SECONDS = parseInt(
  process.env.PROFILE_CHAIN_NAME_RETRY_MAX_SECONDS || '3600',
  10,
);

export const PROFILE_CHAIN_NAME_MAX_RETRIES = parseInt(
  process.env.PROFILE_CHAIN_NAME_MAX_RETRIES || '10',
  10,
);

export const PROFILE_MUTATION_FUNCTIONS = [
  'set_profile',
  'set_profile_full',
  'set_custom_name',
  'clear_custom_name',
  'set_chain_name',
  'clear_chain_name',
  'set_x_name_with_attestation',
  'clear_x_name',
] as const;

export const PROFILE_REGISTRY_ACI = [
  {
    name: 'get_profile',
    arguments: [{ name: 'owner', type: 'address' }],
    payable: false,
    returns: {
      type: {
        option: {
          record: [
            { name: 'fullname', type: 'string' },
            { name: 'bio', type: 'string' },
            { name: 'avatarurl', type: 'string' },
            { name: 'username', type: { option: 'string' } },
            { name: 'x_username', type: { option: 'string' } },
            { name: 'chain_name', type: { option: 'string' } },
            { name: 'chain_expires_at', type: { option: 'int' } },
          ],
        },
      },
    },
    stateful: false,
  },
  {
    name: 'resolve_public_name',
    arguments: [{ name: 'name', type: 'string' }],
    payable: false,
    returns: { type: { option: 'address' } },
    stateful: false,
  },
];
