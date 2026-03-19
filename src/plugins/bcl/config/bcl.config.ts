import { Encoded } from '@aeternity/aepp-sdk';
import { registerAs } from '@nestjs/config';
import { BCL_FACTORY } from '@/configs/contracts';
import { ACTIVE_NETWORK_ID } from '@/configs/network';

const BCL_FUNCTIONS = {
  buy: 'buy',
  sell: 'sell',
  create_community: 'create_community',
} as const;

/**
 * BCL contract config for the active network (address and startHeight from BCL_FACTORY).
 */
export const BCL_CONTRACT = {
  get contractAddress(): Encoded.ContractAddress {
    return BCL_FACTORY[ACTIVE_NETWORK_ID]?.address as Encoded.ContractAddress;
  },
  get collectionAddress(): string {
    const collections = BCL_FACTORY[ACTIVE_NETWORK_ID]?.collections;
    return (collections && Object.keys(collections)[0]) ?? '';
  },
  get startHeight(): number {
    return BCL_FACTORY[ACTIVE_NETWORK_ID]?.deployed_at_block_height ?? 0;
  },
  FUNCTIONS: BCL_FUNCTIONS,
};

export default registerAs('bcl', () => ({
  contract: BCL_CONTRACT,
}));
