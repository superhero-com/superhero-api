import { Encoded, toAe } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import { CoinGeckoService } from 'src/ae/coin-gecko.service';
import { TokenGatingService } from 'src/ae/token-gating.service';
import { TX_FUNCTIONS } from 'src/ae/utils/constants';
import { ITransaction } from 'src/ae/utils/types';
import { Token } from 'src/tokens/entities/token.entity';
import { TokensService } from 'src/tokens/tokens.service';
import { Repository } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';
import moment from 'moment';
import { TokenWebsocketGateway } from 'src/tokens/token-websocket.gateway';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import {
  SYNC_TOKEN_HOLDERS_QUEUE,
  SYNC_TOKENS_RANKS_QUEUE,
} from 'src/tokens/queues/constants';

@Injectable()
export class TransactionService {
  constructor(
    private tokenGatingService: TokenGatingService,
    private coinGeckoService: CoinGeckoService,
    private tokenService: TokensService,
    private tokenWebsocketGateway: TokenWebsocketGateway,

    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,

    @InjectQueue(SYNC_TOKEN_HOLDERS_QUEUE)
    private readonly syncTokenHoldersQueue: Queue,

    @InjectQueue(SYNC_TOKENS_RANKS_QUEUE)
    private readonly syncTokensRanksQueue: Queue,
  ) {
    //
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

    if (!token) {
      token = await this.tokenService.getToken(saleAddress);
    }
    if (rawTransaction.tx.function === TX_FUNCTIONS.create_community) {
      try {
        await this.tokenService.update(token, {
          creator_address: rawTransaction.tx.callerId,
          created_at: moment(rawTransaction.microTime).toDate(),
        });
      } catch (error) {
        console.error(error);
      }
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
    } = await this.parseTransactionData(rawTransaction);

    // if volume is 0 & tx type is not create_community ignore it
    if (
      (volume.isZero() &&
        rawTransaction.tx.function !== TX_FUNCTIONS.create_community) ||
      rawTransaction.tx.returnType === 'revert'
    ) {
      return;
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
        this.coinGeckoService.getPriceData(_amount),
        this.coinGeckoService.getPriceData(_unit_price),
        this.coinGeckoService.getPriceData(_previous_buy_price),
        this.coinGeckoService.getPriceData(_buy_price),
        this.coinGeckoService.getPriceData(_market_cap),
      ]);

    const txData = {
      tx_type: rawTransaction.tx.function,
      tx_hash: rawTransaction.hash,
      block_height: rawTransaction.blockHeight,
      address: rawTransaction.tx.callerId,
      volume,
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
    if (exists) {
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

    if (shouldBroadcast) {
      await this.tokenService.syncTokenPrice(token);
      this.tokenWebsocketGateway?.handleTokenHistory({
        sale_address: saleAddress,
        data: txData,
      });
      void this.syncTokenHoldersQueue.add({
        saleAddress,
      });
      void this.syncTokensRanksQueue.add({});
    }
    return transaction;
  }

  async parseTransactionData(rawTransaction: ITransaction): Promise<{
    volume: BigNumber;
    amount: BigNumber;
    total_supply: BigNumber;
  }> {
    const decodedData = rawTransaction.tx.decodedData;
    let volume = new BigNumber(0);
    let amount = new BigNumber(0);
    let total_supply = new BigNumber(0);

    try {
      if (rawTransaction.tx.function === TX_FUNCTIONS.buy) {
        const mints = decodedData.filter((data) => data.name === 'Mint');
        volume = new BigNumber(toAe(mints[mints.length - 1].args[1]));
        amount = new BigNumber(
          toAe(decodedData.find((data) => data.name === 'Buy').args[0]),
        );
        total_supply = new BigNumber(
          toAe(decodedData.find((data) => data.name === 'Buy').args[2]),
        );
      }

      if (rawTransaction.tx.function === TX_FUNCTIONS.create_community) {
        if (!decodedData.find((data) => data.name === 'PriceChange')) {
          return {
            volume,
            amount,
            total_supply,
          };
        }
        const mints = decodedData.filter((data) => data.name === 'Mint');
        volume = new BigNumber(toAe(mints[mints.length - 1].args[1]));
        amount = new BigNumber(
          toAe(decodedData.find((data) => data.name === 'Buy').args[0]),
        );
        total_supply = new BigNumber(
          toAe(decodedData.find((data) => data.name === 'Buy').args[2]),
        );
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
        );
      }
    } catch (error) {
      console.log('failed to parse transaction data: ', rawTransaction?.hash);
    }

    return {
      volume,
      amount,
      total_supply,
    };
  }

  async decodeTransactionData(
    token: Token,
    rawTransaction: ITransaction,
  ): Promise<ITransaction> {
    try {
      const factory = await this.tokenGatingService.loadTokenGatingFactory(
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
}
