import { Encoded } from '@aeternity/aepp-sdk';
import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { AeSdkService } from './ae/ae-sdk.service';
import { TokenGatingService } from './ae/token-gating.service';
import { ROOM_FACTORY_CONTRACTS, TX_FUNCTIONS } from './ae/utils/constants';
import { ACTIVE_NETWORK } from './ae/utils/networks';
import { ICommunityFactoryContract, ITransaction } from './ae/utils/types';
import { WebSocketService } from './ae/websocket.service';
import { PULL_TOKEN_PRICE_QUEUE } from './tokens/queues/constants';
import {
  SAVE_TRANSACTION_QUEUE,
  SYNC_TRANSACTIONS_QUEUE,
} from './transactions/queues/constants';

@Injectable()
export class AppService {
  tokens: Encoded.ContractAddress[] = [];

  constructor(
    private aeSdkService: AeSdkService,
    private tokenGatingService: TokenGatingService,
    private websocketService: WebSocketService,
    @InjectQueue(PULL_TOKEN_PRICE_QUEUE)
    private readonly pullTokenPriceQueue: Queue,

    @InjectQueue(SAVE_TRANSACTION_QUEUE)
    private readonly saveTransactionQueue: Queue,

    @InjectQueue(SYNC_TRANSACTIONS_QUEUE)
    private readonly syncTransactionsQueue: Queue,
  ) {
    const contracts = ROOM_FACTORY_CONTRACTS[ACTIVE_NETWORK.networkId];

    void this.loadFactories(contracts);

    websocketService.subscribeForTransactionsUpdates(
      (transaction: ITransaction) => {
        if (
          contracts.some(
            (contract) => contract.contractId === transaction.tx.contractId,
          )
        ) {
          const saleAddress = transaction.tx.return.value[1].value;
          if (!this.tokens.includes(saleAddress)) {
            void this.pullTokenPriceQueue.add({
              saleAddress,
            });
            this.tokens.push(saleAddress);
          }
        }
        if (
          transaction.tx.contractId &&
          Object.keys(TX_FUNCTIONS).includes(transaction.tx.function)
        ) {
          void this.saveTransactionQueue.add({
            transaction,
            shouldBroadcast: true,
          });
        }
      },
    );
  }

  async loadFactory(address: Encoded.ContractAddress) {
    const factory =
      await this.tokenGatingService.loadTokenGatingFactory(address);
    const [registeredTokens] = await Promise.all([
      factory.listRegisteredTokens(),
    ]);
    for (const [symbol, saleAddress] of Array.from(registeredTokens)) {
      const job = await this.pullTokenPriceQueue.add({
        saleAddress,
      });
      console.log('TokenSaleService->loadFactory->add-token', symbol, job.id);
      this.tokens.push(saleAddress);
    }

    for (const [symbol, saleAddress] of Array.from(registeredTokens)) {
      // sync token transactions
      const job = await this.syncTransactionsQueue.add({
        saleAddress,
      });
      console.log('TokenSaleService->syncTokenTransactions', symbol, job.id);
    }
  }

  async loadFactories(contracts: ICommunityFactoryContract[]) {
    await Promise.all(
      contracts.map((contract) => this.loadFactory(contract.contractId)),
    );
  }

  /**
   * Retrieves the current version of the API from the package data.
   *
   * @returns {string} The version of the API.
   */
  getApiVersion() {
    return process.env.npm_package_version;
  }
}
