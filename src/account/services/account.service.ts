import { TX_FUNCTIONS } from '@/configs';
import { PULL_ACCOUNTS_ENABLED } from '@/configs/constants';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import { Repository } from 'typeorm';
import { Account } from '../entities/account.entity';

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,

    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
  ) {
    //
  }

  onModuleInit() {
    if (PULL_ACCOUNTS_ENABLED) {
      this.saveAllActiveAccounts();
    }
  }

  isPullingAccounts = false;
  async saveAllActiveAccounts() {
    if (this.isPullingAccounts) {
      return;
    }
    this.isPullingAccounts = true;
    try {
      const uniqueAddresses = await this.transactionRepository
        .createQueryBuilder('transaction')
        .select(
          'DISTINCT ON (transaction.address) transaction.address',
          'address',
        )
        .getRawMany();

      for (const address of uniqueAddresses) {
        const accountExists = await this.accountRepository.exists({
          where: { address: address.address },
        });

        if (accountExists) {
          continue;
        }

        const totalTransactions = await this.transactionRepository.count({
          where: { address: address.address },
        });
        const totalBuyTransactions = await this.transactionRepository.count({
          where: { address: address.address, tx_type: TX_FUNCTIONS.buy },
        });
        const totalSellTransactions = await this.transactionRepository.count({
          where: { address: address.address, tx_type: TX_FUNCTIONS.sell },
        });
        const totalCreatedTokens = await this.transactionRepository.count({
          where: {
            address: address.address,
            tx_type: TX_FUNCTIONS.create_community,
          },
        });

        // total volume sum of amount->ae
        const totalVolume = await this.transactionRepository
          .createQueryBuilder('transactions')
          .select(
            "SUM(CAST(NULLIF(transactions.amount->>'ae', 'NaN') AS DECIMAL))",
            'total_volume',
          )
          .where('transactions.address = :address', {
            address: address.address,
          })
          .getRawOne();

        const accountData = {
          address: address.address,
          total_tx_count: totalTransactions,
          total_buy_tx_count: totalBuyTransactions,
          total_sell_tx_count: totalSellTransactions,
          total_created_tokens: totalCreatedTokens,
          total_volume: new BigNumber(totalVolume.total_volume),
        };

        await this.accountRepository.save(accountData);
      }
    } catch (error) {
      this.logger.error('Error pulling and saving accounts', error);
    }
    this.isPullingAccounts = false;
  }
}
