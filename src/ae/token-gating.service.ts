import { Encoded } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { CommunityFactory, initCommunityFactory } from 'token-gating-sdk';
import { AeSdkService } from './ae-sdk.service';
import { COMMUNITY_FACTORY_CONTRACT_ADDRESS } from './utils/constants';
import { ACTIVE_NETWORK } from './utils/networks';

@Injectable()
export class TokenGatingService {
  factories: Record<Encoded.ContractAddress, CommunityFactory> = {};
  constructor(private aeSdkService: AeSdkService) {
    this.getCurrentTokenGatingFactory().then(() =>
      console.log('TokenGatingService->factoryAddress:'),
    );
  }

  async getCurrentTokenGatingFactory(): Promise<CommunityFactory> {
    return this.loadTokenGatingFactory(this.getCurrentFactoryAddress());
  }

  getCurrentFactoryAddress = () =>
    COMMUNITY_FACTORY_CONTRACT_ADDRESS[ACTIVE_NETWORK.networkId];

  async loadTokenGatingFactory(
    address: Encoded.ContractAddress,
  ): Promise<CommunityFactory> {
    if (this.factories[address]) {
      return this.factories[address];
    }

    const factory = await initCommunityFactory(this.aeSdkService.sdk, address);

    this.factories[address] = factory;

    return factory;
  }
}
