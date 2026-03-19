import { registerAs } from '@nestjs/config';
import { Encoded } from '@aeternity/aepp-sdk';
import {
  ACTIVE_NETWORK_ID,
  INetworkTypes,
  NETWORK_ID_MAINNET,
  NETWORK_ID_TESTNET,
} from '@/configs/network';

export const GOVERNANCE_FUNCTIONS = {
  add_poll: 'add_poll',
  vote: 'vote',
  revoke_vote: 'revoke_vote',
  delegate: 'delegate',
  revoke_delegation: 'revoke_delegation',
} as const;

export interface IGovernanceContractConfig {
  contractAddress: Encoded.ContractAddress;
  startHeight: number;
  FUNCTIONS: typeof GOVERNANCE_FUNCTIONS;
}

/**
 * Configuration for governance contract per network.
 */
export const GOVERNANCE_CONTRACTS_BY_NETWORK: Record<
  INetworkTypes,
  IGovernanceContractConfig
> = {
  [NETWORK_ID_MAINNET]: {
    contractAddress:
      'ct_ouZib4wT9cNwgRA1pxgA63XEUd8eQRrG8PcePDEYogBc1VYTq' as Encoded.ContractAddress,
    startHeight: 164578,
    FUNCTIONS: GOVERNANCE_FUNCTIONS,
  },
  [NETWORK_ID_TESTNET]: {
    contractAddress:
      'ct_2nritSnqW6zooEL4g2SMW5pf12GUbrNyZ17osTLrap7wXiSSjf' as Encoded.ContractAddress,
    startHeight: 168710,
    FUNCTIONS: GOVERNANCE_FUNCTIONS,
  },
};

/** Contract for the active network (all existing GOVERNANCE_CONTRACT usages keep working). */
export const GOVERNANCE_CONTRACT: IGovernanceContractConfig =
  GOVERNANCE_CONTRACTS_BY_NETWORK[ACTIVE_NETWORK_ID];

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
