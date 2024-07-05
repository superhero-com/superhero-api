import { Injectable } from '@nestjs/common';

import { Encoded } from '@aeternity/aepp-sdk';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { AeSdkService } from 'src/ae/ae-sdk.service';
import { ROOM_FACTORY_CONTRACTS } from 'src/ae/utils/constants';
import { ACTIVE_NETWORK } from 'src/ae/utils/networks';
import { ITransaction } from 'src/ae/utils/types';
import { WebSocketService } from 'src/ae/websocket.service';
import { initRoomFactory } from 'token-sale-sdk';
import { PULL_TOKEN_META_DATA_QUEUE, PULL_TOKEN_PRICE_QUEUE } from './queues';

@Injectable()
export class TokenSaleService {
  tokens: Encoded.ContractAddress[] = [];

  constructor(
    private aeSdkService: AeSdkService,
    private websocketService: WebSocketService,
    @InjectQueue(PULL_TOKEN_PRICE_QUEUE)
    private readonly pullTokenPriceQueue: Queue,
    @InjectQueue(PULL_TOKEN_META_DATA_QUEUE)
    private readonly pullTokenMetaDataQueue: Queue,
  ) {
    console.log('TokenSaleService created v2');
    this.loadFactories();

    websocketService.subscribeForTransactionsUpdates(
      (transaction: ITransaction) => {
        if (this.tokens.includes(transaction.tx.contractId)) {
          this.pullTokenPriceQueue.add({
            saleAddress: transaction.tx.contractId,
            transaction,
            live: true,
          });
        }
      },
    );
  }

  async loadFactory(address: Encoded.ContractAddress) {
    const factory = await initRoomFactory(this.aeSdkService.sdk, address);
    const [registeredTokens] = await Promise.all([
      factory.listRegisteredTokens(),
    ]);
    Array.from(registeredTokens)
      // .slice(0, 5)
      .forEach(async ([symbol, saleAddress]) => {
        const job = await this.pullTokenMetaDataQueue.add({
          saleAddress,
        });
        console.log('TokenSaleService->loadFactory->add-token', symbol, job.id);
        this.tokens.push(saleAddress);
      });
  }

  async loadFactories() {
    const contracts = ROOM_FACTORY_CONTRACTS[ACTIVE_NETWORK.networkId];
    await Promise.all(
      contracts.map((contract) => this.loadFactory(contract.contractId)),
    );
  }
}
