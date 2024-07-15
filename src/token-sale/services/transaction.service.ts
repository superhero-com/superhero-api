import { Encoded, toAe } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import moment from 'moment';
import { CoinGeckoService } from 'src/ae/coin-gecko.service';
import { TX_FUNCTIONS } from 'src/ae/utils/constants';
import { ITransaction } from 'src/ae/utils/types';
import { TokenTransaction } from 'src/tokens/entities/token-transaction.entity';
import { Token } from 'src/tokens/entities/token.entity';
import { Repository } from 'typeorm';
import { PriceHistoryService } from './price-history.service';

@Injectable()
export class TransactionService {
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(TokenTransaction)
    private tokenTransactionRepository: Repository<TokenTransaction>,
    private coinGeckoService: CoinGeckoService,

    private priceHistoryService: PriceHistoryService,
  ) {}

  async saveTransaction(transaction: ITransaction) {
    const token = await this.getToken(transaction.tx.contractId);
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

    const tokenPriceData =
      await this.getPricingDataFromTransaction(transaction);

    const tokenTransaction = await this.tokenTransactionRepository.save({
      ...tokenPriceData,
      token: token,
      tx_hash: transaction.hash,
      created_at: moment(transaction.microTime).toDate(),
    });

    // if tx_type create_community, update token creator
    if (transaction.tx.function === 'create_community') {
      try {
        await this.tokensRepository.update(token.id, {
          owner_address: transaction.tx.callerId,
        });
      } catch (error) {
        console.error(error);
      }
    }

    return this.priceHistoryService.saveTokenHistoryFromTransaction(
      tokenTransaction,
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
        return new BigNumber(toAe(transaction.tx.amount.toString()));
      }
    } catch (e) {
      console.error(e);
    }

    return new BigNumber(0);
  }

  getTxAmount(transaction: ITransaction): BigNumber {
    try {
      if (transaction.tx.function === TX_FUNCTIONS.buy) {
        return new BigNumber(toAe(transaction.tx.amount.toString()));
      }

      if (transaction.tx.function === TX_FUNCTIONS.sell) {
        return new BigNumber(toAe(transaction.tx.return?.value.toString()));
      }

      if (transaction.tx.function === TX_FUNCTIONS.create_community) {
        return new BigNumber(toAe(transaction.tx.amount.toString()));
      }
    } catch (e) {
      console.error(e);
    }

    return new BigNumber(0);
  }

  calculateTxSpentAePrice(transaction: ITransaction): BigNumber {
    try {
      const spentAeAmount = this.getTxAmount(transaction);
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
    const price = this.calculateTxSpentAePrice(transaction);
    const volume = this.calculateTxVolume(transaction);
    const amount = this.getTxAmount(transaction);

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
}
