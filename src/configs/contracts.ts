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
    affiliation_address:
      'ct_2GG42rs2FDPTXuUCWHMn98bu5Ab6mgNxY7KdGAKUNsrLqutNxZ',
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
        description: 'Allowed: A–Z, 0–9, and -',
      },

      'CHINESE-ak_2vmVWHYLRaqdoyLdWEUBi1NodQ3MA1bFuqqRe9A5DgNv3qoDuV': {
        id: 'CHINESE-ak_2vmVWHYLRaqdoyLdWEUBi1NodQ3MA1bFuqqRe9A5DgNv3qoDuV',
        name: 'CHINESE',
        allowed_name_length: '20',
        // Chinese ideographs (U+4E00–U+9FFF) + "-" separator — no digits, no Latin.
        allowed_name_chars: [
          { SingleChar: [45] },
          { CharRangeFromTo: [19968, 40959] },
        ],
        description: '允许：汉字和 -',
      },

      'ARABIC-ak_2vmVWHYLRaqdoyLdWEUBi1NodQ3MA1bFuqqRe9A5DgNv3qoDuV': {
        id: 'ARABIC-ak_2vmVWHYLRaqdoyLdWEUBi1NodQ3MA1bFuqqRe9A5DgNv3qoDuV',
        name: 'ARABIC',
        allowed_name_length: '20',
        // Arabic letters (U+0621–U+064A) + "-" separator — no digits, no Latin.
        allowed_name_chars: [
          { SingleChar: [45] },
          { CharRangeFromTo: [1569, 1610] },
        ],
        description: 'المسموح به: الأحرف العربية و -',
      },

      'RUSSIAN-ak_2vmVWHYLRaqdoyLdWEUBi1NodQ3MA1bFuqqRe9A5DgNv3qoDuV': {
        id: 'RUSSIAN-ak_2vmVWHYLRaqdoyLdWEUBi1NodQ3MA1bFuqqRe9A5DgNv3qoDuV',
        name: 'RUSSIAN',
        allowed_name_length: '20',
        // Russian UPPERCASE Cyrillic — А–Я (U+0410–U+042F) + Ё (U+0401) + "-"; no digits, no Latin, no lowercase.
        allowed_name_chars: [
          { SingleChar: [45] },
          { SingleChar: [1025] },
          { CharRangeFromTo: [1040, 1071] },
        ],
        description: 'Разрешено: А–Я, Ё и -',
      },
    },
  },
  [NETWORK_ID_TESTNET]: {
    address: 'ct_vLKrYRCthfViqUuWFKGYgz7kxhvrsdAoKhZPXqzxcaEFRkZy1',
    bctsl_aex9_address: 'ct_2cyV58CrBwi2k4kvP3mN517C1NH21zfxxYmaAyb41GXdXSsRvN',
    deployed_at_block_height: 1097291,
    affiliation_address:
      'ct_2QmAcPxY4TBbFmkSUhxU4UTwoRot8SMmZzaAKL6oyHmQqRL1rK',
    collections: {
      'WORDS-ak_BrJErWKWYUNqGcXzDniXf13saPV6H1dsh1NaDsm913vbPGAH6': {
        id: 'WORDS-ak_BrJErWKWYUNqGcXzDniXf13saPV6H1dsh1NaDsm913vbPGAH6',
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
        description: 'Allowed: A–Z, 0–9, and -',
      },

      'CHINESE-ak_3A4gmzXZdgW4Wa6hsoiPFcr5CHNHcFgCkRQxuwFmNRZ59F6Ns': {
        id: 'CHINESE-ak_3A4gmzXZdgW4Wa6hsoiPFcr5CHNHcFgCkRQxuwFmNRZ59F6Ns',
        name: 'CHINESE',
        allowed_name_length: '20',
        // Chinese ideographs (U+4E00–U+9FFF) + "-" separator — no digits, no Latin.
        allowed_name_chars: [
          { SingleChar: [45] },
          { CharRangeFromTo: [19968, 40959] },
        ],
        description: '允许：汉字和 -',
      },

      'ARABIC-ak_3A4gmzXZdgW4Wa6hsoiPFcr5CHNHcFgCkRQxuwFmNRZ59F6Ns': {
        id: 'ARABIC-ak_3A4gmzXZdgW4Wa6hsoiPFcr5CHNHcFgCkRQxuwFmNRZ59F6Ns',
        name: 'ARABIC',
        allowed_name_length: '20',
        // Arabic letters (U+0621–U+064A) + "-" separator — no digits, no Latin.
        allowed_name_chars: [
          { SingleChar: [45] },
          { CharRangeFromTo: [1569, 1610] },
        ],
        description: 'المسموح به: الأحرف العربية و -',
      },

      'RUSSIAN-ak_3A4gmzXZdgW4Wa6hsoiPFcr5CHNHcFgCkRQxuwFmNRZ59F6Ns': {
        id: 'RUSSIAN-ak_3A4gmzXZdgW4Wa6hsoiPFcr5CHNHcFgCkRQxuwFmNRZ59F6Ns',
        name: 'RUSSIAN',
        allowed_name_length: '20',
        // Russian UPPERCASE Cyrillic — А–Я (U+0410–U+042F) + Ё (U+0401) + "-"; no digits, no Latin, no lowercase.
        allowed_name_chars: [
          { SingleChar: [45] },
          { SingleChar: [1025] },
          { CharRangeFromTo: [1040, 1071] },
        ],
        description: 'Разрешено: А–Я, Ё и -',
      },
    },
  },
};
