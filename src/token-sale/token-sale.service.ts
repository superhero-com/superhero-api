import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';

import { Encoded } from '@aeternity/aepp-sdk';
import { InjectRepository } from '@nestjs/typeorm';
import { AeSdkService } from 'src/ae/ae-sdk.service';
import { ROOM_FACTORY_CONTRACTS } from 'src/ae/utils/constants';
import {
  INetworkTypes,
  NETWORKS,
  NETWORK_ID_MAINNET,
  NETWORK_ID_TESTNET,
} from 'src/ae/utils/networks';
import { WebSocketService } from 'src/ae/websocket.service';
import { TokensService } from 'src/tokens/tokens.service';
import { RoomFactory, initRoomFactory } from 'token-sale-sdk';
import { Token } from '../tokens/entities/token.entity';

export interface ITokenSaleFactory {
  factory: RoomFactory;
  address: Encoded.ContractAddress;
  bondingCurveAddress: Encoded.ContractAddress;
}

@Injectable()
export class TokenSaleService {
  tokenSaleFactories: Record<
    INetworkTypes,
    Record<Encoded.ContractAddress, ITokenSaleFactory>
  > = {
    [NETWORK_ID_MAINNET]: {},
    [NETWORK_ID_TESTNET]: {},
  };

  activeNetworkId = NETWORK_ID_TESTNET;

  initRoomFactory: typeof initRoomFactory;

  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,
    private tokensService: TokensService,
    private aeSdkService: AeSdkService,
    private websocketService: WebSocketService,
  ) {
    this.aeSdkService.sdk.selectNode(NETWORKS[this.activeNetworkId].name);

    console.log('TokenSaleService created v2');
    this.loadFactories();

    // websocketService.subscribeForTransactionsUpdates(
    //   (transaction: ITransaction) => {
    //     console.log('TokenSaleService->new transaction', transaction);
    //   },
    // );
  }

  async loadFactory(address: Encoded.ContractAddress) {
    console.log('TokenSaleService->loadFactory', address);
    const factory = await initRoomFactory(this.aeSdkService.sdk, address);
    const [bondingCurveAddress, registeredTokens] = await Promise.all([
      factory.bondingCurveAddress(),
      factory.listRegisteredTokens(),
    ]);
    Array.from(registeredTokens).forEach(([symbol, saleAddress]) => {
      this.tokensService.save({
        name: symbol,
        address: saleAddress,
        factory_address: address,
      });
    });
    const tokenSaleFactory = {
      address,
      factory,
      bondingCurveAddress,
    };
    this.tokenSaleFactories[this.activeNetworkId][address] = tokenSaleFactory;
    return tokenSaleFactory;
  }

  async loadFactories() {
    console.log('TokenSaleService->loadFactories');
    const contracts = ROOM_FACTORY_CONTRACTS[this.activeNetworkId];
    await Promise.all(
      contracts.map((contract) => this.loadFactory(contract.contractId)),
    );
  }
}
