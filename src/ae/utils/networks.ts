import { ACTIVE_NETWORK_ID } from '../../configs/network';

/**
 * Default `networkId` values returned by the Node after establishing the connection.
 * Nodes returns different values when connecting to the Hyperchains.
 */
export const NETWORK_ID_MAINNET = 'ae_mainnet';
export const NETWORK_ID_TESTNET = 'ae_uat';

export const NETWORK_MAINNET: INetwork = {
  url: 'https://mainnet.aeternity.io',
  networkId: NETWORK_ID_MAINNET,
  middlewareUrl: 'https://mainnet.aeternity.io/mdw',
  explorerUrl: 'https://aescan.io',
  compilerUrl: 'https://v7.compiler.aepps.com',
  websocketUrl: 'wss://mainnet.aeternity.io/mdw/v2/websocket',
  name: 'Mainnet',
};

export const NETWORK_TESTNET: INetwork = {
  url: 'https://testnet.aeternity.io',
  networkId: NETWORK_ID_TESTNET,
  middlewareUrl: 'https://testnet.aeternity.io/mdw',
  explorerUrl: 'https://testnet.aescan.io',
  compilerUrl: 'https://v7.compiler.aepps.com',
  websocketUrl: 'wss://testnet.aeternity.io/mdw/v2/websocket',
  name: 'Testnet',
};

export const NETWORKS = {
  [NETWORK_ID_MAINNET]: NETWORK_MAINNET,
  [NETWORK_ID_TESTNET]: NETWORK_TESTNET,
};

export const ACTIVE_NETWORK: INetwork = NETWORKS[ACTIVE_NETWORK_ID];

export interface INetwork {
  url: string;
  name: string;
  middlewareUrl: string;
  explorerUrl: string;
  networkId: INetworkTypes;
  compilerUrl: string;
  websocketUrl: string;
  index?: number;
}

export type INetworkTypes = keyof typeof NETWORKS;
