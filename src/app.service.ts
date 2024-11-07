import { Encoded } from '@aeternity/aepp-sdk';
import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { TokenGatingService } from './ae/token-gating.service';
import { ROOM_FACTORY_CONTRACTS, TX_FUNCTIONS } from './ae/utils/constants';
import { ACTIVE_NETWORK } from './ae/utils/networks';
import { ICommunityFactoryContract, ITransaction } from './ae/utils/types';
import { WebSocketService } from './ae/websocket.service';
import {
  DELETE_OLD_TOKENS_QUEUE,
  PULL_TOKEN_PRICE_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
  SYNC_TOKENS_RANKS_QUEUE,
} from './tokens/queues/constants';
import {
  SAVE_TRANSACTION_QUEUE,
  SYNC_TRANSACTIONS_QUEUE,
  VALIDATE_TRANSACTIONS_QUEUE,
} from './transactions/queues/constants';

@Injectable()
export class AppService {
  constructor(
    private tokenGatingService: TokenGatingService,
    private websocketService: WebSocketService,
    @InjectQueue(PULL_TOKEN_PRICE_QUEUE)
    private readonly pullTokenPriceQueue: Queue,

    @InjectQueue(SAVE_TRANSACTION_QUEUE)
    private readonly saveTransactionQueue: Queue,

    @InjectQueue(SYNC_TRANSACTIONS_QUEUE)
    private readonly syncTransactionsQueue: Queue,

    @InjectQueue(SYNC_TOKENS_RANKS_QUEUE)
    private readonly syncTokensRanksQueue: Queue,

    @InjectQueue(SYNC_TOKEN_HOLDERS_QUEUE)
    private readonly syncTokenHoldersQueue: Queue,

    @InjectQueue(DELETE_OLD_TOKENS_QUEUE)
    private readonly deleteOldTokensQueue: Queue,

    @InjectQueue(VALIDATE_TRANSACTIONS_QUEUE)
    private readonly validateTransactionsQueue: Queue,
  ) {
    this.init();
  }

  async init() {
    // clean all queue jobs
    await Promise.all([
      this.pullTokenPriceQueue.empty(),
      this.saveTransactionQueue.empty(),
      this.syncTransactionsQueue.empty(),
      this.syncTokensRanksQueue.empty(),
      this.syncTokenHoldersQueue.empty(),
      this.deleteOldTokensQueue.empty(),
      this.validateTransactionsQueue.empty(),
    ]);
    const contracts = ROOM_FACTORY_CONTRACTS[ACTIVE_NETWORK.networkId];
    void this.deleteOldTokensQueue.add({
      factories: contracts.map((contract) => contract.contractId),
    });
    void this.syncTokensRanksQueue.add({});
    void this.loadFactories(contracts);

    this.websocketService.subscribeForTransactionsUpdates(
      (transaction: ITransaction) => {
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

    this.websocketService.subscribeForKeyBlocksUpdates((keyBlock) => {
      const desiredBlockHeight = keyBlock.height - 5;
      void this.validateTransactionsQueue.add({
        from: desiredBlockHeight - 10,
        to: desiredBlockHeight,
      });
    });
  }

  async loadFactory(address: Encoded.ContractAddress) {
    const factory =
      await this.tokenGatingService.loadTokenGatingFactory(address);
    const [registeredTokens] = await Promise.all([
      factory.listRegisteredTokens(),
    ]);
    for (const [symbol, saleAddress] of Array.from(registeredTokens)) {
      console.log('TokenSaleService->dispatch::', symbol, saleAddress);
      this.loadTokenData(saleAddress);
    }
  }

  async loadFactories(contracts: ICommunityFactoryContract[]) {
    await Promise.all(
      contracts.map((contract) => this.loadFactory(contract.contractId)),
    );
  }

  loadTokenData(saleAddress: Encoded.ContractAddress) {
    void this.pullTokenPriceQueue.add({
      saleAddress,
    });
    void this.syncTokenHoldersQueue.add({
      saleAddress,
    });
    void this.syncTransactionsQueue.add({
      saleAddress,
    });
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
