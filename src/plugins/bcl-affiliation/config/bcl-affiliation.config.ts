import { Encoded } from '@aeternity/aepp-sdk';
import { registerAs } from '@nestjs/config';

/**
 * Configuration for governance contract
 */
export const BCL_AFFILIATION_CONTRACT = {
  contractAddress: 'ct_2GG42rs2FDPTXuUCWHMn98bu5Ab6mgNxY7KdGAKUNsrLqutNxZ' as Encoded.ContractAddress,
  startHeight: 1089546,

  FUNCTIONS: {
    register_invitation_code: 'register_invitation_code',
    redeem_invitation_code: 'redeem_invitation_code',
    revoke_invitation_code: 'revoke_invitation_code',
    withdraw: 'withdraw',
  },
};

export default registerAs('bcl-affiliation', () => ({
  contract: BCL_AFFILIATION_CONTRACT,
}));
