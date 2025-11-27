import { TX_FUNCTIONS, ACTIVE_NETWORK } from '@/configs';
import { PULL_ACCOUNTS_ENABLED } from '@/configs/constants';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { Account } from '../entities/account.entity';
import { fetchJson } from '@/utils/common';

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

  /**
   * Fetches the chain name for an account from middleware
   * Returns the newest chain name that currently points to the account
   * @returns string if chain name found, null if no chain name exists, undefined if fetch failed
   */
  async getChainNameForAccount(accountAddress: string): Promise<string | null | undefined> {
    try {
      const middlewareUrl = ACTIVE_NETWORK.middlewareUrl;
      const pointeesUrl = `${middlewareUrl}/v3/accounts/${encodeURIComponent(accountAddress)}/names/pointees`;
      
      const response = await fetchJson<{ data: Array<{
        active: boolean;
        name: string;
        block_height?: number;
        block_time?: number;
        tx: {
          pointers: Array<{
            id: string;
            key: string;
            encoded_key: string;
          }>;
        };
      }> }>(pointeesUrl);

      if (!response?.data || !Array.isArray(response.data)) {
        return null;
      }

      // Group names by name string and get the latest entry for each name
      // The API returns historical records, so we need to use only the most recent pointer update
      const latestByName = new Map<string, typeof response.data[0]>();

      for (const name of response.data) {
        if (!name.active || !name.tx?.pointers || !Array.isArray(name.tx.pointers)) {
          continue;
        }

        const existing = latestByName.get(name.name);
        const nameBlockHeight = name.block_height ?? 0;

        // Keep only the latest entry for each name (highest block_height)
        if (!existing || nameBlockHeight > (existing.block_height ?? 0)) {
          latestByName.set(name.name, name);
        }
      }

      // Verify current pointer state for each name by querying the name directly
      // The /names/pointees endpoint returns historical records, so we need to check current state
      const verifiedNames: Array<{ name: string; blockHeight: number; time: number }> = [];

      // Check each name's current state
      for (const name of latestByName.values()) {
        try {
          // Query the name directly to get its current pointer state
          const nameUrl = `${middlewareUrl}/v3/names/${encodeURIComponent(name.name)}`;
          const nameResponse = await fetchJson<{
            active: boolean;
            pointers: Array<{ id: string }>;
          }>(nameUrl);

          if (!nameResponse?.pointers || !Array.isArray(nameResponse.pointers)) {
            // If name query fails, fall back to using the pointees data
            // But only if the name was active in the pointees response
            const hasMatchingPointer = name.tx.pointers.some(
              pointer => pointer && pointer.id === accountAddress
            );
            if (hasMatchingPointer && name.active) {
              verifiedNames.push({
                name: name.name,
                blockHeight: name.block_height ?? 0,
                time: name.block_time ?? 0,
              });
            }
            continue;
          }

          // Check if the name is active AND the CURRENT pointer points to this account address
          // An inactive name shouldn't be considered as "currently pointing" to the account
          const isActive = nameResponse.active === true;
          const hasMatchingPointer = nameResponse.pointers.some(
            (pointer: any) => pointer && pointer.id === accountAddress
          );

          if (isActive && hasMatchingPointer) {
            verifiedNames.push({
              name: name.name,
              blockHeight: name.block_height ?? 0,
              time: name.block_time ?? 0,
            });
          }
        } catch (e) {
          // If verification fails, fall back to pointees data
          // But only if the name was active in the pointees response
          const hasMatchingPointer = name.tx.pointers.some(
            pointer => pointer && pointer.id === accountAddress
          );
          if (hasMatchingPointer && name.active) {
            verifiedNames.push({
              name: name.name,
              blockHeight: name.block_height ?? 0,
              time: name.block_time ?? 0,
            });
          }
        }
      }

      if (verifiedNames.length === 0) {
        return null;
      }

      // Sort by block_height (descending), then by time (descending) as fallback
      // The newest pointer will have the highest block_height
      verifiedNames.sort((a, b) => {
        if (a.blockHeight !== b.blockHeight) {
          return b.blockHeight - a.blockHeight; // Higher block_height = newer
        }
        return b.time - a.time; // Higher time = newer
      });

      // Return the name with the newest pointer
      return verifiedNames[0].name;
    } catch (error) {
      // Return undefined to indicate fetch failure (not "no chain name")
      // This allows the caller to preserve existing chain_name instead of overwriting with null
      this.logger.warn(`Failed to fetch chain name for ${accountAddress}`, error);
      return undefined;
    }
  }

  /**
   * Periodically refresh chain names for accounts that have them
   * Runs every hour to keep chain names up to date
   */
  private isRefreshingChainNames = false;

  @Cron(CronExpression.EVERY_HOUR)
  async refreshChainNamesPeriodically(): Promise<void> {
    if (this.isRefreshingChainNames) {
      return;
    }

    this.isRefreshingChainNames = true;
    try {
      // Find accounts with chain names that haven't been updated in the last 23 hours
      // This ensures we refresh them before they become stale (24h threshold)
      const staleThreshold = new Date(Date.now() - 23 * 60 * 60 * 1000);
      
      const accountsToRefresh = await this.accountRepository.find({
        where: [
          { chain_name: Not(IsNull()), chain_name_updated_at: LessThan(staleThreshold) },
          { chain_name: Not(IsNull()), chain_name_updated_at: IsNull() },
        ],
        take: 100, // Process in batches to avoid overwhelming middleware
      });

      this.logger.log(`Refreshing chain names for ${accountsToRefresh.length} accounts`);

      // Refresh chain names in parallel (but limit concurrency)
      const batchSize = 10;
      for (let i = 0; i < accountsToRefresh.length; i += batchSize) {
        const batch = accountsToRefresh.slice(i, i + batchSize);
        await Promise.allSettled(
          batch.map(async (account) => {
            try {
              const chainName = await this.getChainNameForAccount(account.address);
              
              // Only update if fetch succeeded (not undefined)
              // undefined means fetch failed - preserve existing chain_name to avoid data loss
              if (chainName !== undefined) {
                const updateData: Partial<Account> = {
                  chain_name: chainName,
                  chain_name_updated_at: new Date(),
                };
                await this.accountRepository.update(account.address, updateData);
              }
              // If chainName is undefined, skip update to preserve existing chain_name
            } catch (error) {
              this.logger.warn(`Failed to refresh chain name for ${account.address}`, error);
            }
          })
        );
      }

      this.logger.log(`Finished refreshing chain names`);
    } catch (error) {
      this.logger.error('Error refreshing chain names', error);
    } finally {
      this.isRefreshingChainNames = false;
    }
  }
}
