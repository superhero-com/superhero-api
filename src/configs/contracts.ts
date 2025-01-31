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
    address: 'ct_NV8W3LnriBtdsbivPAo4jGQs68gA7HBPXVjnMMysuXqNSeMXG',
    collections: {
      'WORDS-ak_b8N3csfrdb1PWLWeA5xbxSeeaKLFnBfkdVayLt7ZqDdFnSCaZ': {
        id: 'WORDS-ak_b8N3csfrdb1PWLWeA5xbxSeeaKLFnBfkdVayLt7ZqDdFnSCaZ',
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
