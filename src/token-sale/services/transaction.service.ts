import { toAe } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import BigNumber from 'bignumber.js';
import { TX_FUNCTIONS } from 'src/ae/utils/constants';
import { ITransaction } from 'src/ae/utils/types';

@Injectable()
export class TransactionService {
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
}
