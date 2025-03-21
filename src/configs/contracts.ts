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
    address: 'ct_Q6nXuqr7Ba14noX6xkpTvMsejgErGn7om34wcWBeZ6ivPxEnJ',
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
};
