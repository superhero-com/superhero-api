import { ICommunityFactorySchema } from 'src/utils/types';
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
    address: 'ct_2i4e5bXZbAsdjZZRikZEvBA1M8B5xn9shpVPQJiqUoNWDCPuUm',
    collections: {},
  },
  [NETWORK_ID_TESTNET]: {
    address: 'ct_2UGLvS4zBMG6W7KEM46qgcaom7FXSNNx99pjeyU7AykXQcwzV2',
    collections: {
      'WORDS-ak_LMYXQ6mRKUwyMwrCuCZ2TmzUUySNmmjL2ehabSSXCx2W65uyE': {
        id: 'WORDS-ak_LMYXQ6mRKUwyMwrCuCZ2TmzUUySNmmjL2ehabSSXCx2W65uyE',
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
};
