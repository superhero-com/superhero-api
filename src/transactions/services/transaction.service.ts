import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { BCL_FUNCTIONS } from '@/configs';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { Token } from '@/tokens/entities/token.entity';
import { TokenWebsocketGateway } from '@/tokens/token-websocket.gateway';
import { TokensService } from '@/tokens/tokens.service';
import { ITransaction } from '@/utils/types';
import { Encoded, toAe } from '@aeternity/aepp-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import moment from 'moment';
import { Repository } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';
import { Tx } from '@/mdw-sync/entities/tx.entity';

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
  ) {
    // this._testTransaction(
    //   'th_8B9qcMtArB59kBAHKKzPo4JXyECgBUBDH415gy8a3K69yr837',
    // );
  }

  /**
   * @deprecated Transaction saving is now handled by the BCL plugin (BclPluginSyncService.processTransaction).
   * This method is kept for backward compatibility but will be removed in a future version.
   * Use the plugin system for modern transaction processing.
   */
  async saveTransaction(
    rawTransaction: ITransaction,
    token?: Token,
    shouldBroadcast?: boolean,
  ): Promise<Transaction> {
    if (
      !Object.keys(BCL_FUNCTIONS).includes(rawTransaction?.tx?.function) ||
      rawTransaction?.tx?.returnType === 'revert'
    ) {
      return;
    }
    let saleAddress;
    if (token?.sale_address) {
      saleAddress = token.sale_address;
    } else {
      saleAddress = rawTransaction.tx.contractId;
      if (rawTransaction.tx.function == BCL_FUNCTIONS.create_community) {
        if (!rawTransaction.tx.return.value.length) {
          return;
        }
        saleAddress = rawTransaction.tx.return.value[1].value;
        // remove any transaction with the same sale address
        await this.transactionRepository
          .createQueryBuilder('transactions')
          .delete()
          .where('transactions.sale_address = :sale_address', {
            sale_address: saleAddress,
          })
          .andWhere('transactions.tx_type = :tx_type', {
            tx_type: BCL_FUNCTIONS.create_community,
          })
          .andWhere('transactions.tx_hash != :tx_hash', {
            tx_hash: rawTransaction.hash,
          })
          .execute();
      }

      /**
       * if the token doesn't exists get token will create it.
       */
      try {
        token = await this.tokenService.getToken(saleAddress);
      } catch (error) {
        this.logger.error(`Error getting token ${saleAddress}`, error);
      }
    }

    if (!token) {
      token =
        await this.tokenService.createTokenFromRawTransaction(rawTransaction);
      // creat token from tx
      if (!token) {
        return;
      }
    }

    const exists = await this.transactionRepository
      .createQueryBuilder('token_transactions')
      .where('token_transactions.tx_hash = :tx_hash', {
        tx_hash: rawTransaction.hash,
      })
      .getOne();

    if (!!exists) {
      return exists;
    }

    rawTransaction = await this.decodeTransactionData(token, rawTransaction);

    const {
      amount: _amount,
      volume,
      total_supply,
      protocol_reward,
      _should_revalidate,
    } = await this.parseTransactionData(rawTransaction);

    if (
      rawTransaction.tx.function == BCL_FUNCTIONS.create_community &&
      !token.factory_address
    ) {
      await this.tokenService.updateTokenMetaDataFromCreateTx(
        token,
        rawTransaction,
      );
      token = await this.tokenService.findByAddress(token.sale_address);
    }

    const decodedData = rawTransaction.tx.decodedData;

    const priceChangeData = decodedData?.find(
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
      sale_address: saleAddress,
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
      verified:
        !_should_revalidate &&
        moment().diff(moment(rawTransaction.microTime), 'hours') >= 5,
    };
    const transaction = await this.transactionRepository.save(txData);

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
      await this.tokenService.updateTokenTrendingScore(token);
    }
    return transaction;
  }

  async parseTransactionData(rawTransaction: ITransaction): Promise<{
    volume: BigNumber;
    amount: BigNumber;
    total_supply: BigNumber;
    protocol_reward: BigNumber;
    _should_revalidate: boolean;
  }> {
    const decodedData = rawTransaction.tx.decodedData;
    let volume = new BigNumber(0);
    let amount = new BigNumber(0);
    let total_supply = new BigNumber(0);
    let protocol_reward = new BigNumber(0);

    if (!decodedData || decodedData.length == 0) {
      return {
        volume,
        amount,
        total_supply,
        protocol_reward,
        _should_revalidate: true,
      };
    }

    if (rawTransaction.tx.function === BCL_FUNCTIONS.buy) {
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

    if (rawTransaction.tx.function === BCL_FUNCTIONS.create_community) {
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

    if (rawTransaction.tx.function === BCL_FUNCTIONS.sell) {
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

    return {
      volume,
      amount,
      total_supply,
      protocol_reward,
      _should_revalidate: false,
    };
  }

  async decodeTxEvents(
    token: Token,
    tx: Tx,
    retries = 0,
  ): Promise<Tx> {
    try {
      const factory = await this.communityFactoryService.loadFactory(
        token.factory_address as Encoded.ContractAddress,
      );
      const decodedData = factory.contract.$decodeEvents(tx.raw.log, {
        omitUnknown: true,
      });

      return {
        ...tx,
        raw: {
          ...tx.raw,
          decodedData,
        },
      };
    } catch (error: any) {
      if (retries < 3) {
        return this.decodeTxEvents(token, tx, retries + 1);
      }
      this.logger.error(
        `decodeTxData->error:: retry ${retries}/3`,
        error,
        error.stack,
      );
      return tx;
    }
  }

  /**
   * TODO: remove
   * @deprecated
   */
  async decodeTransactionData(
    token: Token,
    rawTransaction: ITransaction,
    retries = 0,
  ): Promise<ITransaction> {
    try {
      const factory = await this.communityFactoryService.loadFactory(
        token.factory_address as Encoded.ContractAddress,
      );
      const decodedData = factory.contract.$decodeEvents(rawTransaction.tx.log, {
        omitUnknown: true,
      });

      return {
        ...rawTransaction,
        tx: {
          ...rawTransaction.tx,
          decodedData,
        },
      };
    } catch (error: any) {
      if (retries < 3) {
        return this.decodeTransactionData(token, rawTransaction, retries + 1);
      }
      this.logger.error(
        `decodeTransactionData->error:: retry ${retries}/3`,
        error,
        error.stack,
      );
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
      .where('token_transactions.sale_address = :sale_address', {
        sale_address: token.sale_address,
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

  async updateTokenHolder(
    token: Token,
    rawTransaction: ITransaction,
    volume: BigNumber,
  ): Promise<void> {
    try {
      const bigNumberVolume = new BigNumber(volume).multipliedBy(10 ** 18);
      const tokenHolderCount = await this.tokenHolderRepository
        .createQueryBuilder('token_holders')
        .where('token_holders.aex9_address = :aex9_address', {
          aex9_address: token.address,
        })
        .getCount();

      const tokenHolder = await this.tokenHolderRepository
        .createQueryBuilder('token_holders')
        .where('token_holders.aex9_address = :aex9_address', {
          aex9_address: token.address,
        })
        .andWhere('token_holders.address = :address', {
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
        if (rawTransaction.tx.function === BCL_FUNCTIONS.buy) {
          await this.tokenHolderRepository.update(tokenHolder.id, {
            balance: tokenHolderBalance.plus(bigNumberVolume),
            last_tx_hash: rawTransaction.hash,
            block_number: rawTransaction.blockHeight,
          });
        }
        // if is sell
        if (rawTransaction.tx.function === BCL_FUNCTIONS.sell) {
          await this.tokenHolderRepository.update(tokenHolder.id, {
            balance: tokenHolderBalance.minus(bigNumberVolume),
            last_tx_hash: rawTransaction.hash,
            block_number: rawTransaction.blockHeight,
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
          id: `${rawTransaction.tx.callerId}_${token.address}`,
          aex9_address: token.address,
          address: rawTransaction.tx.callerId,
          balance: bigNumberVolume,
          last_tx_hash: rawTransaction.hash,
          block_number: rawTransaction.blockHeight,
        });
        // increment token holders count
        await this.tokenService.update(token, {
          holders_count: tokenHolderCount + 1,
        });
      }
    } catch (error) {
      this.logger.error('Error updating token holder', error);
    }
    try {
      await this.tokenService.loadAndSaveTokenHoldersFromMdw(
        token.sale_address as Encoded.ContractAddress,
      );
    } catch (error: any) {
      this.logger.error(
        `Error loading and saving token holders from mdw`,
        error,
        error.stack,
      );
    }
  }

  async deleteNonValidTransactionsInBlock(
    blockNumber: number,
    hashes: string[],
  ) {
    await this.transactionRepository
      .createQueryBuilder('transactions')
      .delete()
      .where('transactions.block_height = :block_height', {
        block_height: blockNumber,
      })
      .andWhere('transactions.tx_hash NOT IN (:...hashes)', { hashes })
      .execute();
  }
}
