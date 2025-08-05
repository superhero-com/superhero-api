import { CommunityFactoryService } from '@/ae/community-factory.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '../entities/account.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { TX_FUNCTIONS } from '@/configs';
import BigNumber from 'bignumber.js';

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,

    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,

    private communityFactoryService: CommunityFactoryService,
  ) { }

  onModuleInit() {
    //

    /**
     * TODO:
     * 1. pull all accounts that have made transactions
     * 2. save them to the database
     */
    this.saveAllActiveAccounts();
  }

  async saveAllActiveAccounts() {

    const uniqueAddresses = await this.transactionRepository
      .createQueryBuilder('transaction')
      .select(
        'DISTINCT ON (transaction.address) transaction.address',
        'address',
      )
      .getRawMany();

    console.log('====================');
    console.log('uniqueAddresses::', uniqueAddresses.length);
    console.log('====================');
    console.log('====================');

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
        .where('transactions.address = :address', { address: address.address })
        .getRawOne();

      const accountData = {
        address: address.address,
        total_tx_count: totalTransactions,
        total_buy_tx_count: totalBuyTransactions,
        total_sell_tx_count: totalSellTransactions,
        total_created_tokens: totalCreatedTokens,
        total_volume: new BigNumber(totalVolume.total_volume),
      };
      console.log('====================');
      console.log('totalVolume::', accountData);
      console.log('====================');

      await this.accountRepository.save(accountData);
    }
  }
}
