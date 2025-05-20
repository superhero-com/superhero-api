import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { TX_FUNCTIONS } from '@/configs';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { Token } from '@/tokens/entities/token.entity';
import { SYNC_TOKEN_HOLDERS_QUEUE } from '@/tokens/queues/constants';
import { TokenWebsocketGateway } from '@/tokens/token-websocket.gateway';
import { TokensService } from '@/tokens/tokens.service';
import { ITransaction } from '@/utils/types';
import { Encoded, toAe } from '@aeternity/aepp-sdk';
import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import { Queue } from 'bull';
import moment from 'moment';
import { Repository } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';

@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    private readonly communityFactoryService: CommunityFactoryService,
    private readonly aePricingService: AePricingService,
    private readonly tokenService: TokensService,
    private readonly tokenWebsocketGateway: TokenWebsocketGateway,

    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,

    @InjectRepository(TokenHolder)
    private tokenHolderRepository: Repository<TokenHolder>,

    @InjectQueue(SYNC_TOKEN_HOLDERS_QUEUE)
    private readonly syncTokenHoldersQueue: Queue,
  ) {
    // this._testTransaction(
    //   'th_8B9qcMtArB59kBAHKKzPo4JXyECgBUBDH415gy8a3K69yr837',
    // );
  }

  async saveTransaction(
    rawTransaction: ITransaction,
    token?: Token,
    shouldBroadcast?: boolean,
    shouldValidate?: boolean,
  ): Promise<Transaction> {
    if (!Object.keys(TX_FUNCTIONS).includes(rawTransaction.tx.function)) {
      return;
    }
    // prevent transaction duplication
    let saleAddress = rawTransaction.tx.contractId;
    if (rawTransaction.tx.function == TX_FUNCTIONS.create_community) {
      saleAddress = rawTransaction.tx.return.value[1].value;
    }

    /**
     * if the token doesn't exists get token will create it and call sync token
     * transactions, if the token exists it will just return the token.
     * this will cause create community transaction to be saved twice.
     */
    if (!token) {
      token = await this.tokenService.getToken(saleAddress, !shouldBroadcast);
    }

    const exists = await this.transactionRepository
      .createQueryBuilder('token_transactions')
      .where('token_transactions.tx_hash = :tx_hash', {
        tx_hash: rawTransaction.hash,
      })
      .getOne();

    if (!!exists && (!shouldValidate || exists.verified)) {
      return exists;
    }

    rawTransaction = await this.decodeTransactionData(token, rawTransaction);

    const {
      amount: _amount,
      volume,
      total_supply,
      protocol_reward,
    } = await this.parseTransactionData(rawTransaction);

    // if volume is 0 & tx type is not create_community ignore it
    if (
      (volume.isZero() &&
        rawTransaction.tx.function !== TX_FUNCTIONS.create_community) ||
      rawTransaction.tx.returnType === 'revert'
    ) {
      return;
    }

    if (
      rawTransaction.tx.function == TX_FUNCTIONS.create_community &&
      !token.factory_address
    ) {
      await this.tokenService.updateTokenMetaDataFromCreateTx(
        token,
        rawTransaction,
      );
      token = await this.tokenService.findByAddress(token.sale_address);
    }

    const decodedData = rawTransaction.tx.decodedData;

    const priceChangeData = decodedData.find(
      (data) => data.name === 'PriceChange',
    );
    const _unit_price = _amount.div(volume);
    const _previous_buy_price = !!priceChangeData?.args
      ? new BigNumber(toAe(priceChangeData.args[0]))
      : _unit_price;
    const _buy_price = !!priceChangeData?.args
      ? new BigNumber(toAe(priceChangeData.args[1]))
      : _unit_price;
    const _market_cap = _buy_price.times(total_supply);

    const [amount, unit_price, previous_buy_price, buy_price, market_cap] =
      await Promise.all([
        this.aePricingService.getPriceData(_amount),
        this.aePricingService.getPriceData(_unit_price),
        this.aePricingService.getPriceData(_previous_buy_price),
        this.aePricingService.getPriceData(_buy_price),
        this.aePricingService.getPriceData(_market_cap),
      ]);

    const txData = {
      tx_type: rawTransaction.tx.function,
      tx_hash: rawTransaction.hash,
      block_height: rawTransaction.blockHeight,
      address: rawTransaction.tx.callerId,
      volume,
      protocol_reward,
      amount,
      unit_price,
      previous_buy_price,
      buy_price,
      total_supply,
      market_cap,
      created_at: moment(rawTransaction.microTime).toDate(),
      verified: false,
    };
    // if transaction 2 days old
    if (!!exists?.id) {
      await this.transactionRepository.update(exists.id, {
        ...txData,
        verified: true,
      });
      return exists;
    }
    if (moment().diff(moment(rawTransaction.microTime), 'days') >= 1) {
      txData.verified = true;
    }
    const transaction = this.transactionRepository.save({
      token,
      ...txData,
    } as any);

    if (!this.isTokenSupportedCollection(token)) {
      return transaction;
    }
    if (shouldBroadcast) {
      // it should only broadcast if token is within supported collections
      await this.tokenService.syncTokenPrice(token);
      this.tokenWebsocketGateway?.handleTokenHistory({
        sale_address: saleAddress,
        data: txData,
        token: token,
      });
      // update token holder
      await this.updateTokenHolder(token, rawTransaction, volume);
    }
    return transaction;
  }

  async parseTransactionData(rawTransaction: ITransaction): Promise<{
    volume: BigNumber;
    amount: BigNumber;
    total_supply: BigNumber;
    protocol_reward: BigNumber;
  }> {
    const decodedData = rawTransaction.tx.decodedData;
    let volume = new BigNumber(0);
    let amount = new BigNumber(0);
    let total_supply = new BigNumber(0);
    let protocol_reward = new BigNumber(0);

    if (decodedData.length) {
      try {
        if (rawTransaction.tx.function === TX_FUNCTIONS.buy) {
          const mints = decodedData.filter((data) => data.name === 'Mint');
          protocol_reward = new BigNumber(toAe(mints[0].args[1]));
          volume = new BigNumber(toAe(mints[mints.length - 1].args[1]));
          amount = new BigNumber(
            toAe(decodedData.find((data) => data.name === 'Buy').args[0]),
          );
          total_supply = new BigNumber(
            toAe(decodedData.find((data) => data.name === 'Buy').args[2]),
          ).plus(volume);
        }

        if (rawTransaction.tx.function === TX_FUNCTIONS.create_community) {
          if (decodedData.find((data) => data.name === 'PriceChange')) {
            const mints = decodedData.filter((data) => data.name === 'Mint');
            protocol_reward = new BigNumber(toAe(mints[0].args[1]));
            volume = new BigNumber(toAe(mints[mints.length - 1].args[1]));
            amount = new BigNumber(
              toAe(decodedData.find((data) => data.name === 'Buy').args[0]),
            );
            total_supply = new BigNumber(
              toAe(decodedData.find((data) => data.name === 'Buy').args[2]),
            ).plus(volume);
          }
        }

        if (rawTransaction.tx.function === TX_FUNCTIONS.sell) {
          volume = new BigNumber(
            toAe(decodedData.find((data) => data.name === 'Burn').args[1]),
          );
          amount = new BigNumber(
            toAe(decodedData.find((data) => data.name === 'Sell').args[0]),
          );
          total_supply = new BigNumber(
            toAe(decodedData.find((data) => data.name === 'Sell').args[1]),
          ).minus(volume);
        }
      } catch (error) {
        //
      }
    }

    return {
      volume,
      amount,
      total_supply,
      protocol_reward,
    };
  }

  async decodeTransactionData(
    token: Token,
    rawTransaction: ITransaction,
  ): Promise<ITransaction> {
    try {
      const factory = await this.communityFactoryService.loadFactory(
        token.factory_address as Encoded.ContractAddress,
      );
      const decodedData = factory.contract.$decodeEvents(rawTransaction.tx.log);

      return {
        ...rawTransaction,
        tx: {
          ...rawTransaction.tx,
          decodedData,
        },
      };
    } catch (error) {
      return rawTransaction;
    }
  }

  /**
   * Checks if the given token is part of a supported collection.
   *
   * @param token - The token to check.
   * @returns A promise that resolves to a boolean indicating whether the token is part of a supported collection.
   */
  async isTokenSupportedCollection(token: Token): Promise<boolean> {
    const factory = await this.communityFactoryService.getCurrentFactory();

    if (token.factory_address !== factory.address) {
      return false;
    }

    if (!Object.keys(factory.collections).includes(token.collection)) {
      return false;
    }

    return true;
  }

  async getTokenTransactionsCount(token: Token): Promise<number> {
    const queryBuilder = this.transactionRepository
      .createQueryBuilder('token_transactions')
      .where('token_transactions."tokenId" = :token_id', {
        token_id: token.id,
      });
    return queryBuilder.getCount();
  }

  // FOT TESTING TX
  // async _testTransaction(hash: Encoded.TxHash) {
  //   const url = `${ACTIVE_NETWORK.middlewareUrl}/v2/txs/${hash}`;
  //   let rawTransaction = await fetchJson(url).then((res) =>
  //     camelcaseKeysDeep(res),
  //   );
  //   const token = await this.tokenService.getToken(
  //     rawTransaction.tx.contractId,
  //   );
  //   console.log('==============   response   ==============');
  //   console.log(rawTransaction);
  //   rawTransaction = await this.decodeTransactionData(token, rawTransaction);

  //   const {
  //     amount: _amount,
  //     volume,
  //     total_supply,
  //   } = await this.parseTransactionData(rawTransaction);
  // }

  private async updateTokenHolder(
    token: Token,
    rawTransaction: ITransaction,
    volume: BigNumber,
  ): Promise<void> {
    try {
      const bigNumberVolume = new BigNumber(volume).multipliedBy(10 ** 18);
      const tokenHolder = await this.tokenHolderRepository
        .createQueryBuilder('token_holders')
        .where('token_holders."tokenId" = :token_id', {
          token_id: token.id,
        })
        .andWhere('token_holders."address" = :address', {
          address: rawTransaction.tx.callerId,
        })
        .getOne();
      if (tokenHolder) {
        let tokenHolderBalance = tokenHolder.balance;
        // if balance is negative, set it to 0
        if (tokenHolderBalance.isNegative()) {
          tokenHolderBalance = new BigNumber(0);
        }
        // if is buy
        if (rawTransaction.tx.function === TX_FUNCTIONS.buy) {
          await this.tokenHolderRepository.update(tokenHolder.id, {
            balance: tokenHolderBalance.plus(bigNumberVolume),
          });
        }
        // if is sell
        if (rawTransaction.tx.function === TX_FUNCTIONS.sell) {
          await this.tokenHolderRepository.update(tokenHolder.id, {
            balance: tokenHolderBalance.minus(bigNumberVolume),
          });
        }
        if (token.holders_count == 0) {
          await this.tokenService.update(token, {
            holders_count: 1,
          });
        }
      } else {
        // create token holder
        await this.tokenHolderRepository.save({
          token: token,
          address: rawTransaction.tx.callerId,
          balance: bigNumberVolume,
        });
        // increment token holders count
        await this.tokenService.update(token, {
          holders_count: token.holders_count + 1,
        });
      }
    } catch (error) {
      this.logger.error('Error updating token holder', error);
    }

    void this.syncTokenHoldersQueue.add(
      {
        saleAddress: token.sale_address,
      },
      {
        jobId: `syncTokenHolders-${token.sale_address}`,
        delay: 1000 * 60 * 3, // 3 minutes
      },
    );
  }
}
