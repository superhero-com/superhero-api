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
