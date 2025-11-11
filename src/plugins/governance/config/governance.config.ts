import { registerAs } from '@nestjs/config';

/**
 * Configuration for governance contract
 */
const GOVERNANCE_CONTRACT = {
  contractAddress: 'ct_ouZib4wT9cNwgRA1pxgA63XEUd8eQRrG8PcePDEYogBc1VYTq',
  startHeight: 164578,
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

