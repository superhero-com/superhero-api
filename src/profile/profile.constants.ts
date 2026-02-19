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

export const PROFILE_MUTATION_FUNCTIONS = [
  'set_profile',
  'set_profile_full',
  'set_custom_name',
  'clear_custom_name',
  'set_chain_name',
  'clear_chain_name',
  'set_x_name_with_attestation',
  'clear_x_name',
  'set_display_source',
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
            { name: 'display_source', type: 'string' },
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
