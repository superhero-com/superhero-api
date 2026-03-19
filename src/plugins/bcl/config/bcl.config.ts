import { Encoded } from '@aeternity/aepp-sdk';
import { registerAs } from '@nestjs/config';
import { BCL_FACTORY } from '@/configs/contracts';
import { BCL_FUNCTIONS } from '@/configs/constants';
import { ACTIVE_NETWORK_ID } from '@/configs/network';

/**
 * BCL contract config for the active network (address and startHeight from BCL_FACTORY).
 * FUNCTIONS uses the single source of truth from @/configs/constants so filter and processing logic stay in sync.
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
