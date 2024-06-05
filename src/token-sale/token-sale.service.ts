import { Injectable } from '@nestjs/common';

import { Encoded } from '@aeternity/aepp-sdk';
import { AeSdkService } from 'src/ae/ae-sdk.service';
import { ROOM_FACTORY_CONTRACTS } from 'src/ae/utils/constants';
import {
  INetworkTypes,
  NETWORKS,
  NETWORK_ID_MAINNET,
  NETWORK_ID_TESTNET,
} from 'src/ae/utils/networks';
import { IToken, ITransaction } from 'src/ae/utils/types';
import { WebSocketService } from 'src/ae/websocket.service';
import { TokensService } from 'src/tokens/tokens.service';
import { RoomFactory, initRoomFactory, initTokenSale } from 'token-sale-sdk';

type RoomToken = Partial<IToken> & {
  symbol: string;
  saleAddress: Encoded.ContractAddress;
  factoryAddress: Encoded.ContractAddress;
};

export interface ITokenSaleFactory {
  factory: RoomFactory;
  address: Encoded.ContractAddress;
  bondingCurveAddress: Encoded.ContractAddress;
  tokens: RoomToken[];
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
    private tokensService: TokensService,
    private aeSdkService: AeSdkService,
    private websocketService: WebSocketService,
  ) {
    this.aeSdkService.sdk.selectNode(NETWORKS[this.activeNetworkId].name);

    console.log('TokenSaleService created v2');
    this.loadFactories();

    websocketService.subscribeForTransactionsUpdates(
      (transaction: ITransaction) => {
        const tokenSalesContracts = Object.values(
          this.tokenSaleFactories[this.activeNetworkId],
        ).map((factory: ITokenSaleFactory) =>
          factory.tokens.map((token) => token.saleAddress),
        );

        // merge all contracts
        const contracts = tokenSalesContracts.flat();

        if (contracts.includes(transaction.tx.contractId)) {
          this.loadTokenData(transaction.tx.contractId);
        }
      },
    );
  }

  async loadFactory(
    address: Encoded.ContractAddress,
  ): Promise<ITokenSaleFactory> {
    console.log('TokenSaleService->loadFactory', address);
    const factory = await initRoomFactory(this.aeSdkService.sdk, address);
    const [bondingCurveAddress, registeredTokens] = await Promise.all([
      factory.bondingCurveAddress(),
      factory.listRegisteredTokens(),
    ]);
    const tokens: RoomToken[] = [];
    Array.from(registeredTokens).forEach(([symbol, saleAddress]) => {
      this.tokensService.save({
        name: symbol,
        symbol,
        sale_address: saleAddress,
        factory_address: address,
      });
      tokens.push({
        symbol,
        saleAddress,
        factoryAddress: address,
      });
    });
    const tokenSaleFactory = {
      address,
      factory,
      bondingCurveAddress,
      tokens,
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
    console.log('TokenSaleService->loadFactories done');
    const factories = this.tokenSaleFactories[this.activeNetworkId];
    Object.values(factories).forEach((factory: ITokenSaleFactory) => {
      factory.tokens.forEach((token) => {
        this.loadTokenData(token.saleAddress);
      });
    });
  }

  async getTokenSaleRoomFactory(
    saleAddress: Encoded.ContractAddress,
  ): Promise<ITokenSaleFactory> {
    const factories = this.tokenSaleFactories[this.activeNetworkId];
    const tokenSaleRoomFactory = Object.values(factories).find(
      (factory: ITokenSaleFactory) =>
        factory.tokens.find((token) => token.saleAddress === saleAddress),
    );

    if (!tokenSaleRoomFactory) {
      return this.loadFactory(saleAddress);
    }
    return tokenSaleRoomFactory as ITokenSaleFactory;
  }

  async loadTokenData(saleAddress: Encoded.ContractAddress) {
    const tokenSaleFactory = await this.getTokenSaleRoomFactory(saleAddress);

    if (!tokenSaleFactory) {
      console.error('Token sale factory not found');
      return;
    }

    const { instance } = await initTokenSale(
      this.aeSdkService.sdk,
      saleAddress as Encoded.ContractAddress,
    );
    const contractInstance = await instance.tokenContractInstance();

    const [total_supply] = await Promise.all([
      contractInstance
        .total_supply?.()
        .then((res) => res.decodedResult)
        .catch(() => '0'),
    ]);

    const [tokenMetaInfo, price, sell_price] = await Promise.all([
      instance.metaInfo(),
      instance
        .price(1)
        .then((res: string) => res || '0')
        .catch(() => '0'),
      instance
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        .sellReturn?.('1' as string)
        .then((res: string) => res || '0')
        .catch(() => '0'),
    ]);

    const tokenData = {
      ...(tokenMetaInfo?.token || {}),
      price,
      sell_price,
      market_cap: Number(Number(price) * Number(total_supply)).toString(),
      total_supply: total_supply?.toString(),
    };

    console.log('TokenSaleService->loadTokenData', tokenData);
    this.tokensService.update(saleAddress, tokenData);
  }
}
