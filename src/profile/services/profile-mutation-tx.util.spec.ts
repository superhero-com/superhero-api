import {
  extractProfileMutationCaller,
  extractProfileMutationFunction,
  extractProfileMutationPayload,
  extractProfileMutationXUsername,
  isSuccessfulProfileMutation,
} from './profile-mutation-tx.util';

describe('profile-mutation-tx.util', () => {
  const nestedPayingForTx = {
    tx: {
      payer_id: 'ak_payer',
      tx: {
        signatures: ['sg_inner'],
        tx: {
          contract_id: 'ct_profile',
          function: 'set_x_name_with_attestation',
          caller_id: 'ak_verified_user',
          return_type: 'ok',
          arguments: [{ value: '@VerifiedUser' }],
        },
      },
    },
  };

  it('extracts payload fields from nested paying tx shape', () => {
    expect(extractProfileMutationPayload(nestedPayingForTx)).toEqual(
      nestedPayingForTx.tx.tx.tx,
    );
    expect(extractProfileMutationFunction(nestedPayingForTx)).toBe(
      'set_x_name_with_attestation',
    );
    expect(extractProfileMutationCaller(nestedPayingForTx)).toBe(
      'ak_verified_user',
    );
    expect(extractProfileMutationXUsername(nestedPayingForTx)).toBe(
      'verifieduser',
    );
  });

  it('treats revert and pending as unsuccessful', () => {
    expect(
      isSuccessfulProfileMutation({
        ...nestedPayingForTx,
        tx: {
          ...nestedPayingForTx.tx,
          tx: {
            ...nestedPayingForTx.tx.tx,
            tx: {
              ...nestedPayingForTx.tx.tx.tx,
              return_type: 'revert',
            },
          },
        },
      }),
    ).toBe(false);

    expect(
      isSuccessfulProfileMutation({
        ...nestedPayingForTx,
        tx: { ...nestedPayingForTx.tx, pending: true },
      }),
    ).toBe(false);
  });
});
