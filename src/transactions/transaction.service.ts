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
import { Transaction } from './entities/transaction.entity';

@Injectable()
export class TransactionService {
  constructor(
    private tokenGatingService: TokenGatingService,
    private coinGeckoService: CoinGeckoService,
    private tokenService: TokensService,

    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
  ) {
    //
  }

  async saveTransaction(rawTransaction: ITransaction) {
    console.log('SAVE TRANSACTION', rawTransaction);
    // prevent transaction duplication
    let saleAddress = rawTransaction.tx.contractId;
    if (rawTransaction.tx.function == TX_FUNCTIONS.create_community) {
      saleAddress = rawTransaction.tx.return.value[1].value;
    }

    const token = await this.tokenService.getToken(saleAddress);
    const exists = await this.transactionRepository
      .createQueryBuilder('token_transactions')
      .where('token_transactions.tx_hash = :tx_hash', {
        tx_hash: rawTransaction.hash,
      })
      .getExists();

    if (!token || exists) {
      return;
    }

    rawTransaction = await this.decodeTransactionData(token, rawTransaction);

    const {
      amount: _amount,
      volume,
      total_supply,
    } = await this.parseTransactionData(rawTransaction);

    if (_amount === null) {
      return;
    }

    const decodedData = rawTransaction.tx.decodedData;

    const priceChangeData = decodedData.find(
      (data) => data.name === 'PriceChange',
    );
    const _unit_price = _amount.div(volume);
    const _previous_buy_price = priceChangeData
      ? new BigNumber(toAe(priceChangeData.args[0]))
      : _unit_price;
    const _buy_price = priceChangeData
      ? new BigNumber(toAe(priceChangeData.args[1]))
      : _unit_price;
    const _market_cap = _buy_price.times(total_supply);
    console.log('volume', volume);
    console.log('amount', _amount);
    console.log('====================================');

    const [amount, unit_price, previous_buy_price, buy_price, market_cap] =
      await Promise.all([
        this.coinGeckoService.getPriceData(_amount),
        this.coinGeckoService.getPriceData(_unit_price),
        this.coinGeckoService.getPriceData(_previous_buy_price),
        this.coinGeckoService.getPriceData(_buy_price),
        this.coinGeckoService.getPriceData(_market_cap),
      ]);

    this.transactionRepository.save({
      token,
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
      // TODO created at
    } as any);
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

    if (rawTransaction.tx.function === TX_FUNCTIONS.buy) {
      volume = new BigNumber(
        toAe(decodedData.find((data) => data.name === 'Mint').args[1]),
      );
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
          volume: null,
          amount: null,
          total_supply: null,
        };
      }
      volume = new BigNumber(
        toAe(decodedData.find((data) => data.name === 'Mint').args[1]),
      );
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
      console.log('decodedData', decodedData);
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
