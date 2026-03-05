import { registerAs } from '@nestjs/config';
import { Encoded } from '@aeternity/aepp-sdk';

/**
 * Configuration for governance contract
 */
export const GOVERNANCE_CONTRACT = {
  contractAddress:
    'ct_ouZib4wT9cNwgRA1pxgA63XEUd8eQRrG8PcePDEYogBc1VYTq' as Encoded.ContractAddress,
  startHeight: 164578,

  FUNCTIONS: {
    add_poll: 'add_poll',

    vote: 'vote',
    revoke_vote: 'revoke_vote',

    delegate: 'delegate',
    revoke_delegation: 'revoke_delegation',
  },
};

export default registerAs('governance', () => ({
  contract: GOVERNANCE_CONTRACT,
}));

/**
 * Get contract address from config
 */
export function getContractAddress(): string {
  return GOVERNANCE_CONTRACT.contractAddress;
}

/**
 * Get start height from config
 */
export function getStartHeight(): number {
  return GOVERNANCE_CONTRACT.startHeight;
}
