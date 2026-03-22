import { registerAs } from '@nestjs/config';
import { ACTIVE_NETWORK_ID } from '@/configs/network';
import { POST_CONTRACTS_BY_NETWORK } from '@/social/config/post-contracts.config';
import { IPostContract } from '@/social/interfaces/post.interfaces';

/** Contracts for the active network (single source of truth: @/social/config/post-contracts.config). */
const ACTIVE_POST_CONTRACTS = POST_CONTRACTS_BY_NETWORK[ACTIVE_NETWORK_ID];

export default registerAs('social', () => ({
  contracts: ACTIVE_POST_CONTRACTS,
}));

/**
 * Get contract configuration by address
 * @param contracts - Array of post contracts (from config or default)
 * @param address - Contract address to find
 */
export function getContractByAddress(
  contracts: IPostContract[],
  address: string,
): IPostContract | undefined {
  return contracts.find((contract) => contract.contractAddress === address);
}

/**
 * Get all active contract addresses
 * @param contracts - Array of post contracts (from config or default)
 */
export function getActiveContractAddresses(
  contracts: IPostContract[],
): string[] {
  return contracts.map((contract) => contract.contractAddress);
}

/**
 * Check if a contract address is supported
 * @param contracts - Array of post contracts (from config or default)
 * @param address - Contract address to check
 */
export function isContractSupported(
  contracts: IPostContract[],
  address: string,
): boolean {
  return contracts.some((contract) => contract.contractAddress === address);
}
