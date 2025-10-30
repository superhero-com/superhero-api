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

    // Get all tokens owned by this account
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

    // Calculate portfolio value for each timestamp
    const snapshots: PortfolioHistorySnapshot[] = [];
    for (const timestamp of timestamps) {
      const snapshot = await this.getPortfolioSnapshotAtTimestamp(
        address,
        accountTokens,
        timestamp,
        convertTo,
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
  ): Promise<PortfolioHistorySnapshot> {
    // Get AE balance at timestamp (for now, use current balance)
    // TODO: Implement historical AE balance calculation
    const aeBalance = await this.getAEBalanceAtTimestamp(address, timestamp);

    // Calculate tokens value at this timestamp
    let tokensValueAe = 0;
    for (const holder of accountTokens) {
      const token = await this.tokenRepository.findOne({
        where: { address: holder.aex9_address },
      });
      if (!token || !token.sale_address) continue;

      // Get token price at this timestamp
      const tokenPrice = await this.getTokenPriceAtTimestamp(
        token.sale_address,
        timestamp,
        'ae',
      );

      if (tokenPrice > 0) {
        const decimals = Number(token.decimals) || 18;
        const tokenBalance = Number(holder.balance.toString()) / Math.pow(10, decimals);
        tokensValueAe += tokenBalance * tokenPrice;
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
   * Get AE balance at a specific timestamp
   * For now, returns current balance. TODO: Implement historical balance calculation
   */
  private async getAEBalanceAtTimestamp(
    address: string,
    timestamp: Moment,
  ): Promise<number> {
    try {
      // For MVP, fetch current balance from blockchain
      // TODO: Implement historical balance lookup by tracking transactions or querying blockchain state at specific height
      const balance = await this.aeSdkService.sdk.getBalance(address as any);
      // Convert from aettos to AE
      return Number(toAe(balance));
    } catch (error) {
      this.logger.error(`Error fetching AE balance for ${address}:`, error);
      return 0;
    }
  }
}

