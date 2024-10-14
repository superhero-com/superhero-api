import { Encoded, toAe } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import moment from 'moment';
import { CoinGeckoService } from 'src/ae/coin-gecko.service';
import { TokenGatingService } from 'src/ae/token-gating.service';
import { TX_FUNCTIONS } from 'src/ae/utils/constants';
import { ITransaction } from 'src/ae/utils/types';
import { TokenTransaction } from 'src/tokens/entities/token-transaction.entity';
import { Token } from 'src/tokens/entities/token.entity';
import { Repository } from 'typeorm';
import { PriceHistoryService } from './price-history.service';

@Injectable()
export class TransactionService {
  constructor(
    private tokenGatingService: TokenGatingService,

    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(TokenTransaction)
    private tokenTransactionRepository: Repository<TokenTransaction>,
    private coinGeckoService: CoinGeckoService,

    private priceHistoryService: PriceHistoryService,
  ) {
    //
  }

  async saveTransaction(transaction: ITransaction, shouldSaveHistory = false) {
    let saleAddress = transaction.tx.contractId;
    if (transaction.tx.function == TX_FUNCTIONS.create_community) {
      saleAddress = transaction.tx.return.value[1].value;
    }
    const token = await this.getToken(saleAddress);

    // Prevent duplicate entries
    const exists = await this.tokenTransactionRepository
      .createQueryBuilder('token_transactions')
      .where('token_transactions.tx_hash = :tx_hash', {
        tx_hash: transaction.hash,
      })
      .getExists();

    if (!token || exists) {
      return;
    }

    const transactionWithDecodedData =
      await this.decodeTransactionData(transaction);
    const tokenPriceData = await this.getPricingDataFromTransaction(
      transactionWithDecodedData,
    );

    const tokenTransaction = await this.tokenTransactionRepository.save({
      ...tokenPriceData,
      token: token,
      tx_hash: transaction.hash,
      created_at: moment(transaction.microTime).toDate(),
    });

    // if tx_type create_community, update token creator
    if (transaction.tx.function === TX_FUNCTIONS.create_community) {
      try {
        await this.tokensRepository.update(token.id, {
          creator_address: transaction.tx.callerId,
        });
      } catch (error) {
        console.error(error);
      }
    }

    if (
      !shouldSaveHistory ||
      (transaction.tx.function !== TX_FUNCTIONS.buy &&
        transaction.tx.function !== TX_FUNCTIONS.create_community)
    ) {
      return;
    }

    return this.priceHistoryService.saveTokenHistoryFromTransaction(
      tokenTransaction,
      token,
    );
  }

  calculateTxVolume(transaction: ITransaction): BigNumber {
    try {
      if (transaction.tx.function === TX_FUNCTIONS.buy) {
        return new BigNumber(
          toAe(transaction.tx.arguments[0].value.toString()),
        );
      }

      if (transaction.tx.function === TX_FUNCTIONS.sell) {
        return new BigNumber(
          toAe(transaction.tx.arguments[0].value.toString()),
        );
      }

      if (transaction.tx.function === TX_FUNCTIONS.create_community) {
        return new BigNumber(
          toAe(transaction.tx.arguments[1].value.toString()),
        );
      }
    } catch (e) {
      console.error(e);
    }

    return new BigNumber(0);
  }

  async getTxAmountFromLog(
    transaction: ITransaction,
    name: 'Buy' | 'Sell',
    fallback: BigNumber,
  ): Promise<BigNumber> {
    console.log('======== getTxAmountFromLog =========');
    const priceData: any = transaction.tx.decodedData.filter(
      (d) => d.name === name,
    )[0];

    if (!priceData) {
      return fallback;
    }
    return new BigNumber(toAe(priceData.args[0]));
  }

  async getTxAmount(transaction: ITransaction): Promise<BigNumber> {
    try {
      if (transaction.tx.function === TX_FUNCTIONS.buy) {
        return this.getTxAmountFromLog(
          transaction,
          'Buy',
          new BigNumber(toAe(transaction.tx.amount.toString())),
        );
      }

      if (transaction.tx.function === TX_FUNCTIONS.sell) {
        return this.getTxAmountFromLog(
          transaction,
          'Sell',
          new BigNumber(toAe(transaction.tx.return?.value.toString())),
        );
      }

      if (transaction.tx.function === TX_FUNCTIONS.create_community) {
        return new BigNumber(toAe(transaction.tx.amount.toString()));
      }
    } catch (e) {
      console.error(e);
    }

    return new BigNumber(0);
  }

  async calculateTxSpentAePrice(transaction: ITransaction): Promise<BigNumber> {
    try {
      const spentAeAmount = await this.getTxAmount(transaction);
      if (transaction.tx.function === TX_FUNCTIONS.buy) {
        const totalBoughTokens = new BigNumber(
          toAe(transaction.tx.arguments[0].value.toString()),
        );

        // get the price of 1 token in ae
        return spentAeAmount.div(totalBoughTokens);
      }

      if (transaction.tx.function === TX_FUNCTIONS.sell) {
        const totalBoughTokens = new BigNumber(
          toAe(transaction.tx.arguments[0].value.toString()),
        );

        // get the price of 1 token in ae
        return spentAeAmount.div(totalBoughTokens);
      }

      if (transaction.tx.function === TX_FUNCTIONS.create_community) {
        const totalBoughTokens = new BigNumber(
          toAe(
            transaction.tx.arguments.find((arg) => arg.type === 'int')?.value,
          ),
        );
        return spentAeAmount.div(totalBoughTokens);
      }
    } catch (e) {
      console.error(e);
    }

    return new BigNumber(0);
  }

  async getPricingDataFromTransaction(transaction: ITransaction) {
    const price = await this.calculateTxSpentAePrice(transaction);
    const volume = this.calculateTxVolume(transaction);
    const amount = await this.getTxAmount(transaction);

    const [price_data, amount_data] = await Promise.all([
      this.coinGeckoService.getPriceData(price),
      this.coinGeckoService.getPriceData(amount),
    ]);

    return {
      price,
      price_data,
      volume,
      address: transaction.tx.callerId,
      tx_type: transaction.tx.function,
      amount,
      amount_data,
    };
  }

  async getToken(sale_address: Encoded.ContractAddress) {
    return await this.tokensRepository.findOneBy({
      sale_address: sale_address,
    });
  }

  async decodeTransactionData(
    transaction: ITransaction,
  ): Promise<ITransaction> {
    try {
      const factory =
        await this.tokenGatingService.getCurrentTokenGatingFactory();
      const decodedData = factory.contract.$decodeEvents(transaction.tx.log);
      console.log('decodedData', decodedData);
      return {
        ...transaction,
        tx: {
          ...transaction.tx,
          decodedData,
        },
      };
    } catch (error) {
      return transaction;
    }
  }
}
