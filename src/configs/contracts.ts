import {
  INetworkTypes,
  NETWORK_ID_MAINNET,
  NETWORK_ID_TESTNET,
} from 'src/ae/utils/networks';
import { ICommunityFactoryContracts, IFactorySchema } from 'src/ae/utils/types';

/**
 * Token sale contracts addresses for different networks.
 * The last contract in the array is the default one.
 */
export const BCL_CONTRACTS: ICommunityFactoryContracts = {
  [NETWORK_ID_MAINNET]: [
    {
      contractId: 'ct_2YWMMhFzsQWSNXsBTFZD6A6FHtgtNVbfT2ZtaUpDGpmKPpRXhJ',
      description: 'Token Gating Contract (Mainnet)',
    },
  ],
  [NETWORK_ID_TESTNET]: [
    {
      contractId: 'ct_22ymZBECdNqBWFZ12iZqSxs6DwQHT4XinJaL7gbcXM4yD4iU7p',
      description: 'v1.1.0 name factory 20 alphanumeric chars and hyphen',
    },
    {
      contractId: 'ct_2rBqfMLTn6UuhAJmeyEBnxxTqCnoA5ahpxBM35CRSDkQsvfVpk',
      description: 'v1.1.0 number factory 20 numbers and hyphen',
    },
  ],
};

export const BCL_FACTORY: Record<INetworkTypes, IFactorySchema> = {
  [NETWORK_ID_MAINNET]: {
    address: 'ct_2i4e5bXZbAsdjZZRikZEvBA1M8B5xn9shpVPQJiqUoNWDCPuUm',
    categories: {},
  },
  [NETWORK_ID_TESTNET]: {
    address: 'ct_2i4e5bXZbAsdjZZRikZEvBA1M8B5xn9shpVPQJiqUoNWDCPuUm',
    categories: {
      // 'ALPHA-ak_LMYXQ6mRKUwyMwrCuCZ2TmzUUySNmmjL2ehabSSXCx2W65uyE': {
      //   name: 'ALPHA',
      //   description: 'Token Gating Contract (Testnet)',
      // },
    },
  },
};
