import {
  ACTIVE_NETWORK_ID,
  INetworkTypes,
  NETWORK_ID_MAINNET,
  NETWORK_ID_TESTNET,
} from '@/configs/network';
import { IPostContract } from '../interfaces/post.interfaces';

/**
 * Configuration for supported post contracts per network.
 * Each contract represents a different version or type of social posting functionality.
 */
export const POST_CONTRACTS_BY_NETWORK: Record<
  INetworkTypes,
  IPostContract[]
> = {
  [NETWORK_ID_MAINNET]: [
    {
      contractAddress: 'ct_2Hyt9ZxzXra5NAzhePkRsDPDWppoatVD7CtHnUoHVbuehwR8Nb',
      version: 3,
      description: 'Current social posting contract (mainnet)',
    },
  ],
  [NETWORK_ID_TESTNET]: [
    {
      contractAddress: 'ct_2J1wuuw9urs9ADBh5QbvuPyUCLdKbW5YRkfhgPoN7rGjBbPiBW',
      version: 3,
      description: 'Current social posting contract (testnet)',
    },
  ],
};

/** Contracts for the active network (used by PostService and helpers). */
export const POST_CONTRACTS: IPostContract[] =
  POST_CONTRACTS_BY_NETWORK[ACTIVE_NETWORK_ID];

/**
 * Get contract configuration by address
 */
export function getContractByAddress(
  address: string,
): IPostContract | undefined {
  return POST_CONTRACTS.find(
    (contract) => contract.contractAddress === address,
  );
}

/**
 * Get all active contract addresses
 */
export function getActiveContractAddresses(): string[] {
  return POST_CONTRACTS.map((contract) => contract.contractAddress);
}

/**
 * Check if a contract address is supported
 */
export function isContractSupported(address: string): boolean {
  return POST_CONTRACTS.some(
    (contract) => contract.contractAddress === address,
  );
}
