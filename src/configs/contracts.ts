import { NETWORK_ID_MAINNET, NETWORK_ID_TESTNET } from 'src/ae/utils/networks';
import { ICommunityFactoryContracts } from 'src/ae/utils/types';

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
