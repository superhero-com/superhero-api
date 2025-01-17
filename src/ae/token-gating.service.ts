import { Encoded } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { BCL_CONTRACTS } from 'src/configs';
import { CommunityFactory, initCommunityFactory } from 'token-gating-sdk';
import { AeSdkService } from './ae-sdk.service';
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

  getCurrentFactoryAddress() {
    const contracts = BCL_CONTRACTS[ACTIVE_NETWORK.networkId];

    const latestContract = contracts[contracts.length - 1];

    return latestContract.contractId;
  }

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
