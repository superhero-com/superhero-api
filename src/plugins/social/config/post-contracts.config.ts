import { registerAs } from '@nestjs/config';
import { IPostContract } from '@/social/interfaces/post.interfaces';

/**
 * Configuration for supported post contracts
 * Each contract represents a different version or type of social posting functionality
 */
const POST_CONTRACTS: IPostContract[] = [
  // Commented out older contract - kept for reference
  // {
  //   contractAddress: 'ct_2AfnEfCSZCTEkxL5Yoi4Yfq6fF7YapHRaFKDJK3THMXMBspp5z',
  //   version: 1,
  //   description: 'Legacy tip/retip contract'
  // },
  {
    contractAddress: 'ct_2Hyt9ZxzXra5NAzhePkRsDPDWppoatVD7CtHnUoHVbuehwR8Nb',
    version: 3,
    description: 'Current social posting contract',
  },
];

export default registerAs('social', () => ({
  contracts: POST_CONTRACTS,
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

/**
 * Helper functions that use default contracts (for backward compatibility)
 * These can be used when ConfigService is not available
 */
export const POST_CONTRACTS_DEFAULT = POST_CONTRACTS;

export function getContractByAddressDefault(
  address: string,
): IPostContract | undefined {
  return getContractByAddress(POST_CONTRACTS, address);
}

export function getActiveContractAddressesDefault(): string[] {
  return getActiveContractAddresses(POST_CONTRACTS);
}

export function isContractSupportedDefault(address: string): boolean {
  return isContractSupported(POST_CONTRACTS, address);
}

