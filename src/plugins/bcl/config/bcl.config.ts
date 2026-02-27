import { Encoded } from '@aeternity/aepp-sdk';
import { registerAs } from '@nestjs/config';

/**
 * Configuration for governance contract
 */
export const BCL_CONTRACT = {
  contractAddress:
    'ct_25cqTw85wkF5cbcozmHHUCuybnfH9WaRZXSgEcNNXG9LsCJWTN' as Encoded.ContractAddress,
  collectionAddress:
    'WORDS-ak_2X6puZgdPKcfjSVdUGs2bvsvkbsCLN8XbKQwSVtqLUBc3518bi',
  startHeight: 1089546,

  FUNCTIONS: {
    buy: 'buy',
    sell: 'sell',
    create_community: 'create_community',
  },
};

export default registerAs('bcl', () => ({
  contract: BCL_CONTRACT,
}));
