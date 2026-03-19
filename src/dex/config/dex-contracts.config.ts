// Use deployment ACIs from external dex-contracts to match sdk expectations
import RouterAci from 'dex-contracts-v2/build/AedexV2Router.aci.json';
import FactoryAci from 'dex-contracts-v2/build/AedexV2Factory.aci.json';
import PairAci from 'dex-contracts-v2/build/AedexV2Pair.aci.json';
import Aex9Aci from 'dex-contracts-v2/build/FungibleTokenFull.aci.json';
import {
  ACTIVE_NETWORK_ID,
  INetworkTypes,
  NETWORK_ID_MAINNET,
  NETWORK_ID_TESTNET,
} from '@/configs/network';

export interface IDexContracts {
  factory: string;
  router: string;
  wae: string;
  aeeth: string;
}

/**
 * Configuration for supported dex contracts per network.
 */
export const DEX_CONTRACTS_BY_NETWORK: Record<INetworkTypes, IDexContracts> = {
  [NETWORK_ID_MAINNET]: {
    factory: 'ct_2mfj3FoZxnhkSw5RZMcP8BfPoB1QR4QiYGNCdkAvLZ1zfF6paW',
    router: 'ct_azbNZ1XrPjXfqBqbAh1ffLNTQ1sbnuUDFvJrXjYz7JQA1saQ3',
    wae: 'ct_J3zBY8xxjsRr3QojETNw48Eb38fjvEuJKkQ6KzECvubvEcvCa',
    aeeth: 'ct_ryTY1mxqjCjq1yBn9i6HDaCSdA6thXUFZTA84EMzbWd1SLKdh',
  },
  [NETWORK_ID_TESTNET]: {
    factory: 'ct_NhbxN8wg8NLkGuzwRNDQhMDKSKBwDAQgxQawK7tkigi2aC7i9',
    router: 'ct_MLXQEP12MBn99HL6WDaiTqDbG4bJQ3Q9Bzr57oLfvEkghvpFb',
    wae: 'ct_JDp175ruWd7mQggeHewSLS1PFXt9AzThCDaFedxon8mF8xTRF',
    aeeth: 'ct_WVqAvLQpvZCgBg4faZLXA1YBj43Fxj91D33Z8K7pFsY8YCofv',
  },
};

/** Contracts for the active network (all existing DEX_CONTRACTS usages keep working). */
export const DEX_CONTRACTS: IDexContracts =
  DEX_CONTRACTS_BY_NETWORK[ACTIVE_NETWORK_ID];

export const ACI = {
  Router: RouterAci,
  Factory: FactoryAci,
  Pair: PairAci,
  AEX9: Aex9Aci,
};
