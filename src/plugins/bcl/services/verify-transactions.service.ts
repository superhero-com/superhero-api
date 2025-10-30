import { ACTIVE_NETWORK } from '@/configs/network';
import { Transaction } from '@/plugins/bcl/entities/transaction.entity';
import { TransactionService } from '@/transactions/services/transaction.service';
import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { LessThan, Repository } from 'typeorm';
import { SyncBlocksService } from './sync-blocks.service';
import {
  FIX_FAILED_TRANSACTION_WHEN_BLOCK_HEIGHT_IS_LESS_THAN,
  PERIODIC_SYNCING_ENABLED,
  TX_FUNCTIONS,
  WAIT_TIME_WHEN_REQUEST_FAILED,
} from '@/configs/constants';

@Injectable()
export class VerifyTransactionsService {
  verifyingTransactions = false;
  private readonly logger = new Logger(VerifyTransactionsService.name);

  constructor(
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,

    private readonly transactionService: TransactionService,
    private readonly syncBlocksService: SyncBlocksService,
  ) {
    //
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async fixFailedTransactions() {
    if (!PERIODIC_SYNCING_ENABLED) {
      return;
    }
    if (this.verifyingTransactions) {
      return;
    }
    this.verifyingTransactions = true;
    const transactions = await this.transactionRepository.find({
      where: {
        verified: false,
        block_height: LessThan(
          this.syncBlocksService.currentBlockNumber -
            FIX_FAILED_TRANSACTION_WHEN_BLOCK_HEIGHT_IS_LESS_THAN,
        ),
      },
      order: {
        created_at: 'ASC',
      },
      take: 100,
    });
    if (!transactions.length) {
      this.verifyingTransactions = false;
      return;
    }
    for (const transaction of transactions) {
      await this.verifyTransaction(transaction);
    }

    this.verifyingTransactions = false;
    // wait 3 seconds before the next call
    await new Promise((resolve) =>
      setTimeout(resolve, WAIT_TIME_WHEN_REQUEST_FAILED),
    );

    this.fixFailedTransactions(); // recursive call, until all transactions are verified
  }

  private async verifyTransaction(transaction: Transaction) {
    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions/${transaction.tx_hash}`;
    try {
      const txData: ITransaction = await fetchJson(url).then((res) =>
        camelcaseKeysDeep(res),
      );
      if (txData?.tx?.returnType === 'revert') {
        await this.transactionRepository.delete(transaction.tx_hash);
        return;
      }
      if (
        transaction.block_height !== txData.blockHeight ||
        transaction.tx_type !== txData.tx.function ||
        transaction.address !== txData.tx.callerId
      ) {
        await this.transactionRepository.delete(transaction.tx_hash);
        await this.transactionService.saveTransaction(txData);
        return;
      }

      // if it's create_community, we need to verify the token
      if (txData.tx.function === TX_FUNCTIONS.create_community) {
        const saleAddress = txData.tx.return.value[1].value;
        if (saleAddress !== transaction.sale_address) {
          await this.transactionRepository.delete(transaction.tx_hash);
          await this.transactionService.saveTransaction(txData);
          return;
        }
      }

      await this.transactionRepository.update(transaction.tx_hash, {
        verified: true,
      });
    } catch (error: any) {
      this.logger.error(
        `VerifyTransactionsService: ${transaction.tx_hash} - ${error.message}`,
        error.stack,
      );
      await this.transactionRepository.delete(transaction.tx_hash);
    }
  }
}
