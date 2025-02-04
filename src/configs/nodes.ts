import { Node } from '@aeternity/aepp-sdk';
import { NETWORK_MAINNET, NETWORK_TESTNET } from './network';

export const nodes: { instance: Node; name: string }[] = [
  {
    name: NETWORK_MAINNET.name,
    instance: new Node(NETWORK_MAINNET.url),
  },
  {
    name: NETWORK_TESTNET.name,
    instance: new Node(NETWORK_TESTNET.url),
  },
];
