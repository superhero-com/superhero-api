import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import moment, { Moment } from 'moment';
import { DataSource, Repository } from 'typeorm';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { Token } from '@/tokens/entities/token.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { toAe } from '@aeternity/aepp-sdk';

export interface PortfolioHistorySnapshot {
  timestamp: Date;
  total_value_ae: number;
  ae_balance: number;
  tokens_value_ae: number;
  total_value_usd?: number;
}

export interface GetPortfolioHistoryOptions {
  startDate?: Moment;
  endDate?: Moment;
  interval?: number; // seconds, default 86400 (daily)
  convertTo?: 'ae' | 'usd' | 'eur' | 'aud' | 'brl' | 'cad' | 'chf' | 'gbp' | 'xau';
}

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(
    @InjectRepository(TokenHolder)
    private readonly tokenHolderRepository: Repository<TokenHolder>,
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly aeSdkService: AeSdkService,
  ) {}

  /**
   * Get portfolio history for an account
   */
  async getPortfolioHistory(
    address: string,
    options: GetPortfolioHistoryOptions = {},
  ): Promise<PortfolioHistorySnapshot[]> {
    const {
      startDate,
      endDate,
      interval = 86400, // Default daily (24 hours)
      convertTo = 'ae',
    } = options;

    // Get all tokens owned by this account (for current snapshot or to know which tokens to track)
    const accountTokens = await this.getAccountTokens(address);

    // If no tokens and we're just getting current value, return early
    if (!startDate && !endDate) {
      return [await this.getCurrentPortfolioSnapshot(address, accountTokens, convertTo)];
    }

    // Calculate date range
    const end = endDate || moment();
    const start = startDate || moment().subtract(90, 'days'); // Default to last 90 days

    // Generate timestamp intervals
    const timestamps: Moment[] = [];
    let current = moment(start);
    while (current.isBefore(end) || current.isSame(end, 'day')) {
      timestamps.push(moment(current));
      current.add(interval, 'seconds');
    }

    // If no timestamps, return current snapshot
    if (timestamps.length === 0) {
      return [await this.getCurrentPortfolioSnapshot(address, accountTokens, convertTo)];
    }

    // Batch fetch all transactions for this account up to the end date for efficiency
    const allTransactions = await this.getAllAccountTransactions(address, end);

    // Calculate portfolio value for each timestamp
    const snapshots: PortfolioHistorySnapshot[] = [];
    for (const timestamp of timestamps) {
      const snapshot = await this.getPortfolioSnapshotAtTimestamp(
        address,
        accountTokens,
        timestamp,
        convertTo,
        allTransactions,
      );
      snapshots.push(snapshot);
    }

    return snapshots;
  }

  /**
   * Get all tokens owned by an account
   */
  private async getAccountTokens(address: string): Promise<TokenHolder[]> {
    return await this.tokenHolderRepository
      .createQueryBuilder('holder')
      .where('holder.address = :address', { address })
      .andWhere('holder.balance > 0')
      .getMany();
  }

  /**
   * Get current portfolio snapshot
   */
  private async getCurrentPortfolioSnapshot(
    address: string,
    accountTokens: TokenHolder[],
    convertTo: string,
  ): Promise<PortfolioHistorySnapshot> {
    // Get current AE balance (using current timestamp)
    const aeBalance = await this.getAEBalanceAtTimestamp(address, moment());

    // Calculate tokens value using current prices
    let tokensValueAe = 0;
    for (const holder of accountTokens) {
      const token = await this.tokenRepository.findOne({
        where: { address: holder.aex9_address },
      });
      if (token && token.price_data?.ae) {
        const decimals = Number(token.decimals) || 18;
        const tokenBalance = Number(holder.balance.toString()) / Math.pow(10, decimals);
        const tokenPrice = Number(token.price_data.ae);
        tokensValueAe += tokenBalance * tokenPrice;
      }
    }

    const totalValueAe = aeBalance + tokensValueAe;

    const snapshot: PortfolioHistorySnapshot = {
      timestamp: new Date(),
      total_value_ae: totalValueAe,
      ae_balance: aeBalance,
      tokens_value_ae: tokensValueAe,
    };

    // Add converted value if requested
    if (convertTo !== 'ae') {
      // TODO: Implement currency conversion using AE pricing service
      // For now, return same value
      snapshot.total_value_usd = totalValueAe;
    }

    return snapshot;
  }

  /**
   * Get portfolio snapshot at a specific timestamp
   */
  private async getPortfolioSnapshotAtTimestamp(
    address: string,
    accountTokens: TokenHolder[],
    timestamp: Moment,
    convertTo: string,
    allTransactions?: Transaction[],
  ): Promise<PortfolioHistorySnapshot> {
    // Calculate historical AE balance
    const aeBalance = await this.getAEBalanceAtTimestamp(
      address,
      timestamp,
      allTransactions,
    );

    // Get all unique token sale addresses from transactions (includes tokens that were sold)
    const tokenSaleAddresses = new Set<string>();
    if (allTransactions) {
      for (const tx of allTransactions) {
        if (tx.sale_address && moment(tx.created_at).isSameOrBefore(timestamp)) {
          tokenSaleAddresses.add(tx.sale_address);
        }
      }
    } else {
      // Fallback: use current account tokens
      for (const holder of accountTokens) {
        const token = await this.tokenRepository.findOne({
          where: { address: holder.aex9_address },
        });
        if (token && token.sale_address) {
          tokenSaleAddresses.add(token.sale_address);
        }
      }
    }

    // Batch fetch all tokens at once
    const saleAddressesArray = Array.from(tokenSaleAddresses);
    const tokens = saleAddressesArray.length > 0
      ? await this.tokenRepository
          .createQueryBuilder('token')
          .where('token.sale_address IN (:...saleAddresses)', {
            saleAddresses: saleAddressesArray,
          })
          .getMany()
      : [];
    const tokenMap = new Map<string, Token>();
    for (const token of tokens) {
      if (token.sale_address) {
        tokenMap.set(token.sale_address, token);
      }
    }

    // Calculate tokens value at this timestamp
    let tokensValueAe = 0;
    for (const saleAddress of tokenSaleAddresses) {
      const token = tokenMap.get(saleAddress);
      if (!token) continue;

      // Get historical token balance at this timestamp
      const tokenBalance = await this.getTokenBalanceAtTimestamp(
        address,
        saleAddress,
        timestamp,
        allTransactions,
        token,
      );

      if (tokenBalance > 0) {
        // Get token price at this timestamp
        const tokenPrice = await this.getTokenPriceAtTimestamp(
          saleAddress,
          timestamp,
          'ae',
        );

        if (tokenPrice > 0) {
          tokensValueAe += tokenBalance * tokenPrice;
        }
      }
    }

    const totalValueAe = aeBalance + tokensValueAe;

    const snapshot: PortfolioHistorySnapshot = {
      timestamp: timestamp.toDate(),
      total_value_ae: totalValueAe,
      ae_balance: aeBalance,
      tokens_value_ae: tokensValueAe,
    };

    // Convert to requested currency if needed
    if (convertTo !== 'ae') {
      // TODO: Implement currency conversion using AE pricing service
      // For now, return same value
      snapshot.total_value_usd = totalValueAe;
    }

    return snapshot;
  }

  /**
   * Get token price at a specific timestamp
   */
  private async getTokenPriceAtTimestamp(
    saleAddress: string,
    timestamp: Moment,
    convertTo: string = 'ae',
  ): Promise<number> {
    // Find the most recent transaction before or at this timestamp
    const transaction = await this.transactionRepository
      .createQueryBuilder('tx')
      .where('tx.sale_address = :saleAddress', { saleAddress })
      .andWhere('tx.created_at <= :timestamp', { timestamp: timestamp.toDate() })
      .andWhere(`tx.buy_price->>'${convertTo}' != 'NaN'`)
      .andWhere(`tx.buy_price->>'${convertTo}' IS NOT NULL`)
      .orderBy('tx.created_at', 'DESC')
      .limit(1)
      .getOne();

    if (!transaction || !transaction.buy_price) {
      return 0;
    }

    const price = transaction.buy_price[convertTo];
    if (!price || price === 'NaN') {
      return 0;
    }

    return Number(price);
  }

  /**
   * Get all transactions for an account up to a given timestamp
   */
  private async getAllAccountTransactions(
    address: string,
    endDate: Moment,
  ): Promise<Transaction[]> {
    return await this.transactionRepository
      .createQueryBuilder('tx')
      .where('tx.address = :address', { address })
      .andWhere('tx.created_at <= :endDate', { endDate: endDate.toDate() })
      .orderBy('tx.created_at', 'ASC')
      .getMany();
  }

  /**
   * Get token balance at a specific timestamp by tracking transactions
   */
  private async getTokenBalanceAtTimestamp(
    address: string,
    saleAddress: string,
    timestamp: Moment,
    allTransactions?: Transaction[],
    token?: Token,
  ): Promise<number> {
    try {
      // Use provided transactions or fetch them
      let transactions: Transaction[];
      if (allTransactions) {
        transactions = allTransactions.filter(
          (tx) =>
            tx.sale_address === saleAddress &&
            moment(tx.created_at).isSameOrBefore(timestamp),
        );
      } else {
        transactions = await this.transactionRepository
          .createQueryBuilder('tx')
          .where('tx.address = :address', { address })
          .andWhere('tx.sale_address = :saleAddress', { saleAddress })
          .andWhere('tx.created_at <= :timestamp', { timestamp: timestamp.toDate() })
          .orderBy('tx.created_at', 'ASC')
          .getMany();
      }

      // Calculate balance by summing up transactions
      let balance = new BigNumber(0);
      for (const tx of transactions) {
        if (tx.tx_type === 'buy') {
          balance = balance.plus(tx.volume);
        } else if (tx.tx_type === 'sell') {
          balance = balance.minus(tx.volume);
        }
      }

      // Convert to human-readable format
      const decimals = token ? Number(token.decimals) || 18 : 18;
      const balanceNumber = Number(balance.toString()) / Math.pow(10, decimals);
      return Math.max(0, balanceNumber); // Ensure non-negative
    } catch (error) {
      this.logger.error(
        `Error calculating token balance for ${saleAddress} at ${timestamp.toISOString()}:`,
        error,
      );
      return 0;
    }
  }

  /**
   * Get AE balance at a specific timestamp by tracking transactions
   */
  private async getAEBalanceAtTimestamp(
    address: string,
    timestamp: Moment,
    allTransactions?: Transaction[],
  ): Promise<number> {
    try {
      // Start with current balance
      const currentBalance = await this.aeSdkService.sdk.getBalance(address as any);
      let balance = new BigNumber(currentBalance);

      // Use provided transactions or fetch transactions after the timestamp
      let transactionsAfter: Transaction[];
      if (allTransactions) {
        transactionsAfter = allTransactions.filter((tx) =>
          moment(tx.created_at).isAfter(timestamp),
        );
      } else {
        transactionsAfter = await this.transactionRepository
          .createQueryBuilder('tx')
          .where('tx.address = :address', { address })
          .andWhere('tx.created_at > :timestamp', { timestamp: timestamp.toDate() })
          .orderBy('tx.created_at', 'ASC')
          .getMany();
      }

      // Reverse transactions after the timestamp to get historical balance
      // If someone bought tokens after this timestamp, they spent AE, so add it back
      // If someone sold tokens after this timestamp, they received AE, so subtract it
      // Note: tx.amount.ae is in AE, but balance is in aettos, so we need to convert
      for (const tx of transactionsAfter) {
        if (tx.amount && typeof tx.amount === 'object' && 'ae' in tx.amount) {
          const aeAmountValue = tx.amount.ae;
          // Check if it's a valid number (not NaN, null, or undefined)
          if (
            aeAmountValue != null &&
            typeof aeAmountValue === 'number' &&
            !isNaN(aeAmountValue) &&
            isFinite(aeAmountValue) &&
            aeAmountValue > 0
          ) {
            try {
              // Convert from AE to aettos (multiply by 10^18)
              const aeAmountAettos = new BigNumber(aeAmountValue).multipliedBy(
                new BigNumber(10).pow(18),
              );
              if (tx.tx_type === 'buy') {
                // They spent AE, so add it back to get historical balance
                balance = balance.plus(aeAmountAettos);
              } else if (tx.tx_type === 'sell') {
                // They received AE, so subtract it to get historical balance
                balance = balance.minus(aeAmountAettos);
              }
            } catch (error) {
              this.logger.warn(`Invalid AE amount in transaction ${tx.tx_hash}: ${aeAmountValue}`);
            }
          }
        }
      }

      // Convert from aettos to AE
      return Number(toAe(balance.toString()));
    } catch (error) {
      this.logger.error(`Error fetching AE balance for ${address}:`, error);
      // Fallback to current balance
      try {
        const balance = await this.aeSdkService.sdk.getBalance(address as any);
        return Number(toAe(balance));
      } catch (fallbackError) {
        return 0;
      }
    }
  }
}

