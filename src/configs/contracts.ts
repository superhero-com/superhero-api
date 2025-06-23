import { ICommunityFactorySchema } from '@/utils/types';
import {
  INetworkTypes,
  NETWORK_ID_MAINNET,
  NETWORK_ID_TESTNET,
} from './network';

/**
 * Define the collections you want the api to support for each network.
 * If no collections are defined, the api will support all collections.
 */
export const BCL_FACTORY: Record<INetworkTypes, ICommunityFactorySchema> = {
  [NETWORK_ID_MAINNET]: {
    address: 'ct_25cqTw85wkF5cbcozmHHUCuybnfH9WaRZXSgEcNNXG9LsCJWTN',
    deployed_at_block_height: 1089546,
    bctsl_aex9_address: 'ct_dsa6octVEHPcm7wRszK6VAjPp1FTqMWa7sBFdxQ9jBT35j6VW',
    collections: {
      'WORDS-ak_2X6puZgdPKcfjSVdUGs2bvsvkbsCLN8XbKQwSVtqLUBc3518bi': {
        id: 'WORDS-ak_2X6puZgdPKcfjSVdUGs2bvsvkbsCLN8XbKQwSVtqLUBc3518bi',
        name: 'WORDS',
        allowed_name_length: '20',
        allowed_name_chars: [
          {
            SingleChar: [45],
          },
          {
            CharRangeFromTo: [48, 57],
          },
          {
            CharRangeFromTo: [65, 90],
          },
        ],
        description: 'Tokenize a unique name with up to 20.',
      },
    },
  },
  [NETWORK_ID_TESTNET]: {
    address: 'ct_vLKrYRCthfViqUuWFKGYgz7kxhvrsdAoKhZPXqzxcaEFRkZy1',
    bctsl_aex9_address: 'ct_2cyV58CrBwi2k4kvP3mN517C1NH21zfxxYmaAyb41GXdXSsRvN',
    deployed_at_block_height: 1097291,
    collections: {
      'WORDS-ak_2X6puZgdPKcfjSVdUGs2bvsvkbsCLN8XbKQwSVtqLUBc3518bi': {
        id: 'WORDS-ak_2X6puZgdPKcfjSVdUGs2bvsvkbsCLN8XbKQwSVtqLUBc3518bi',
        name: 'WORDS',
        allowed_name_length: '20',
        allowed_name_chars: [
          {
            SingleChar: [45],
          },
          {
            CharRangeFromTo: [48, 57],
          },
          {
            CharRangeFromTo: [65, 90],
          },
        ],
        description: 'Tokenize a unique name with up to 20.',
      },
      // 'WORDS-ak_2X6puZgdPKcfjSVdUGs2bvsvkbsCLN8XbKQwSVtqLUBc3518bi': {
      //   id: 'WORDS-ak_2X6puZgdPKcfjSVdUGs2bvsvkbsCLN8XbKQwSVtqLUBc3518bi',
      //   name: 'WORDS',
      //   allowed_name_length: '20',
      //   allowed_name_chars: [
      //     {
      //       CharRangeFromTo: [19968, 40959],
      //     },
      //   ],
      //   description: 'Tokenize a unique name with up to 20.',
      // },
    },
  },
};
