import { Encoding } from '@aeternity/aepp-sdk';
import type {
  CurrencyCode,
  ICurrency,
  ICommunityFactoryContracts,
  IToken,
  ICategories,
} from './types';
import { NETWORK_ID_MAINNET, NETWORK_ID_TESTNET } from './networks';

export const AETERNITY_CONTRACT_ID = 'aeternity';
export const AETERNITY_SYMBOL = 'AE';
export const AETERNITY_COIN_ID = 'aeternity';
export const AETERNITY_COIN_SYMBOL = 'AE Coin';
export const AETERNITY_COIN_NAME = 'Aeternity';
export const AETERNITY_COIN_PRECISION = 18; // Amount of decimals

export const AETERNITY_TOKEN_BASE_DATA: Partial<IToken> = {
  address: AETERNITY_CONTRACT_ID,
  decimals: AETERNITY_COIN_PRECISION,
  name: AETERNITY_COIN_NAME,
  symbol: AETERNITY_SYMBOL,
};

export const AE_SYMBOL = 'AE';

export const COMMUNITY_FACTORY_CONTRACT_ADDRESS: ICommunityFactoryContracts = {
  [NETWORK_ID_MAINNET]: 'ct_2YWMMhFzsQWSNXsBTFZD6A6FHtgtNVbfT2ZtaUpDGpmKPpRXhJ',
  [NETWORK_ID_TESTNET]: 'ct_2h4y5gFg7dJkRnXbxmZZKYZyeDrKSbZMtshX1q1u72Zw4KVaNx',
};

export const CATEGORIES: ICategories = {
  [NETWORK_ID_MAINNET]: {},
  [NETWORK_ID_TESTNET]: {
    ALPHA: {
      name: 'ALPHA',
      description: 'Token Gating Contract (Testnet)',
    },
  },
};

export const DEFAULT_CURRENCY_CODE: CurrencyCode = 'usd';

export const CURRENCIES: ICurrency[] = [
  {
    name: 'United States Dollar',
    code: 'usd',
    symbol: '$',
  },
  {
    name: 'Euro',
    code: 'eur',
    symbol: '€',
  },
  {
    name: 'Australia Dollar',
    code: 'aud',
    symbol: 'AU$',
  },
  {
    name: 'Brasil Real',
    code: 'brl',
    symbol: 'R$',
  },
  {
    name: 'Canada Dollar',
    code: 'cad',
    symbol: 'CA$',
  },
  {
    name: 'Swiss Franc',
    code: 'chf',
    symbol: 'CHF',
  },
  {
    name: 'United Kingdom Pound',
    code: 'gbp',
    symbol: '£',
  },
  {
    name: 'Gold Ounce',
    code: 'xau',
    symbol: 'XAU',
  },
];

export const WEB_SOCKET_CHANNELS = {
  Transactions: 'Transactions',
  MicroBlocks: 'MicroBlocks',
  KeyBlocks: 'KeyBlocks',
  Object: 'Object',
};

export const WEB_SOCKET_SOURCE = {
  mdw: 'mdw',
  node: 'node',
};

export const WEB_SOCKET_SUBSCRIBE = 'Subscribe';
export const WEB_SOCKET_UNSUBSCRIBE = 'Unsubscribe';
export const WEB_SOCKET_RECONNECT_TIMEOUT = 20000;

export const PUSH_NOTIFICATION_AUTO_CLOSE_TIMEOUT = 10000;

export const TX_FUNCTIONS = {
  buy: 'buy',
  sell: 'sell',
  create_community: 'create_community',
} as const;

export enum CreateOptionsType {
  FIXED_PRICE = 'FIXED_PRICE',
  BONDING_CURVE = 'BONDING_CURVE',
  CUSTOM_OPTIONS = 'CUSTOM_OPTIONS',
}

export const HASH_REGEX = /^[1-9A-HJ-NP-Za-km-z]{48,50}$/;

export const AE_HASH_PREFIXES_ALLOWED = [
  Encoding.AccountAddress,
  Encoding.Channel,
  Encoding.ContractAddress,
  Encoding.Name,
  Encoding.OracleAddress,
  Encoding.TxHash,
] as const;

export const AE_AENS_DOMAIN = '.chain';
