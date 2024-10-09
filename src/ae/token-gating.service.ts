import { Encoded } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { initRoomFactory, RoomFactory } from 'token-sale-sdk';
import { AeSdkService } from './ae-sdk.service';
import { ROOM_FACTORY_CONTRACTS } from './utils/constants';
import { ACTIVE_NETWORK } from './utils/networks';

@Injectable()
export class TokenGatingService {
  factories: Record<Encoded.ContractAddress, RoomFactory> = {};
  constructor(private aeSdkService: AeSdkService) {
    this.getCurrentTokenGatingFactory().then(() =>
      console.log('TokenGatingService->factoryAddress:'),
    );
  }

  async getCurrentTokenGatingFactory(): Promise<RoomFactory> {
    return this.loadTokenGatingFactory(this.getCurrentFactoryAddress());
  }

  getCurrentFactoryAddress() {
    const contracts = ROOM_FACTORY_CONTRACTS[ACTIVE_NETWORK.networkId];

    const latestContract = contracts[contracts.length - 1];

    return latestContract.contractId;
  }

  async loadTokenGatingFactory(
    address: Encoded.ContractAddress,
  ): Promise<RoomFactory> {
    if (this.factories[address]) {
      return this.factories[address];
    }

    const factory = await initRoomFactory(this.aeSdkService.sdk, address);

    this.factories[address] = factory;

    return factory;
  }
}
