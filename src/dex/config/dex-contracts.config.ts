// Use deployment ACIs from external dex-contracts to match sdk expectations
import RouterAci from 'dex-contracts-v2/build/AedexV2Router.aci.json';
import FactoryAci from 'dex-contracts-v2/build/AedexV2Factory.aci.json';
import PairAci from 'dex-contracts-v2/build/AedexV2Pair.aci.json';
import Aex9Aci from 'dex-contracts-v2/build/FungibleTokenFull.aci.json';

/**
 * Configuration for supported dex contracts
 */
export const DEX_CONTRACTS = {
  factory: 'ct_2mfj3FoZxnhkSw5RZMcP8BfPoB1QR4QiYGNCdkAvLZ1zfF6paW',
  router: 'ct_azbNZ1XrPjXfqBqbAh1ffLNTQ1sbnuUDFvJrXjYz7JQA1saQ3',
  wae: 'ct_J3zBY8xxjsRr3QojETNw48Eb38fjvEuJKkQ6KzECvubvEcvCa',
  aeeth: 'ct_ryTY1mxqjCjq1yBn9i6HDaCSdA6thXUFZTA84EMzbWd1SLKdh',
};

export const ACI = {
  Router: RouterAci,
  Factory: FactoryAci,
  Pair: PairAci,
  AEX9: Aex9Aci,
};
