import { Injectable } from '@nestjs/common';

import { Encoded } from '@aeternity/aepp-sdk';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { AeSdkService } from 'src/ae/ae-sdk.service';
import { ROOM_FACTORY_CONTRACTS, TX_FUNCTIONS } from 'src/ae/utils/constants';
import { ACTIVE_NETWORK } from 'src/ae/utils/networks';
import { IRoomFactoryContract, ITransaction } from 'src/ae/utils/types';
import { WebSocketService } from 'src/ae/websocket.service';
import { initRoomFactory } from 'token-sale-sdk';
import {
  PULL_TOKEN_META_DATA_QUEUE,
  SAVE_TOKEN_TRANSACTION_QUEUE,
} from './queues';

@Injectable()
export class TokenSaleService {
  tokens: Encoded.ContractAddress[] = [];

  constructor(
    private aeSdkService: AeSdkService,
    private websocketService: WebSocketService,
    @InjectQueue(PULL_TOKEN_META_DATA_QUEUE)
    private readonly pullTokenMetaDataQueue: Queue,

    @InjectQueue(SAVE_TOKEN_TRANSACTION_QUEUE)
    private readonly saveTokenTransactionQueue: Queue,
  ) {
    const contracts = ROOM_FACTORY_CONTRACTS[ACTIVE_NETWORK.networkId];

    this.loadFactories(contracts);

    websocketService.subscribeForTransactionsUpdates(
      (transaction: ITransaction) => {
        if (
          contracts.some(
            (contract) => contract.contractId === transaction.tx.contractId,
          )
        ) {
          const saleAddress = transaction.tx.return.value[1].value;
          this.pullTokenMetaDataQueue.add({
            saleAddress,
          });
          this.tokens.push(saleAddress);
        }
        if (
          transaction.tx.contractId &&
          Object.keys(TX_FUNCTIONS).includes(transaction.tx.function)
        ) {
          this.saveTokenTransactionQueue.add({
            transaction,
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
      .slice(0, 5)
      .forEach(async ([symbol, saleAddress]) => {
        const job = await this.pullTokenMetaDataQueue.add({
          saleAddress,
        });
        console.log('TokenSaleService->loadFactory->add-token', symbol, job.id);
        this.tokens.push(saleAddress);
      });
  }

  async loadFactories(contracts: IRoomFactoryContract[]) {
    await Promise.all(
      contracts.map((contract) => this.loadFactory(contract.contractId)),
    );
  }
}
