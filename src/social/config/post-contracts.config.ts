import { IPostContract } from '../interfaces/post.interfaces';

/**
 * Configuration for supported post contracts
 * Each contract represents a different version or type of social posting functionality
 */
export const POST_CONTRACTS: IPostContract[] = [
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
