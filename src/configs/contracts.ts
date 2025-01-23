import {
  INetworkTypes,
  NETWORK_ID_MAINNET,
  NETWORK_ID_TESTNET,
} from 'src/ae/utils/networks';
import { ICommunityFactorySchema } from 'src/ae/utils/types';

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
    address: 'ct_2i4e5bXZbAsdjZZRikZEvBA1M8B5xn9shpVPQJiqUoNWDCPuUm',
    collections: {
      // 'ALPHA-ak_LMYXQ6mRKUwyMwrCuCZ2TmzUUySNmmjL2ehabSSXCx2W65uyE': {
      //   name: 'ALPHA',
      //   allowed_name_length: '20',
      // },
    },
  },
};
