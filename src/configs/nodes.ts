import { Node } from '@aeternity/aepp-sdk';
import { pinNetworkGasPricing } from './gas-price';
import { NETWORK_MAINNET, NETWORK_TESTNET } from './network';

export const nodes: { instance: Node; name: string }[] = [
  {
    name: NETWORK_MAINNET.name,
    instance: pinNetworkGasPricing(new Node(NETWORK_MAINNET.url)),
  },
  {
    name: NETWORK_TESTNET.name,
    instance: pinNetworkGasPricing(new Node(NETWORK_TESTNET.url)),
  },
];
