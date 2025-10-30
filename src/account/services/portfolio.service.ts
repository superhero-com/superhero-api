import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import moment, { Moment } from 'moment';
import { DataSource, Repository } from 'typeorm';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { Token } from '@/tokens/entities/token.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { CoinGeckoService } from '@/ae/coin-gecko.service';
import { AETERNITY_COIN_ID } from '@/configs';
import { toAe } from '@aeternity/aepp-sdk';

export interface PortfolioHistorySnapshot {
  timestamp: Date;
  total_value_ae: number;
  ae_balance: number;
  tokens_value_ae: number;
  total_value_usd?: number; // USD value (or other fiat if convertTo != 'usd')
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
    private readonly coinGeckoService: CoinGeckoService,
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
    this.logger.debug(`Found ${allTransactions.length} transactions for ${address} up to ${end.toISOString()}`);
    if (allTransactions.length > 0) {
      const txTypes = allTransactions.reduce((acc, tx) => {
        acc[tx.tx_type] = (acc[tx.tx_type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      this.logger.debug(`Transaction types: ${JSON.stringify(txTypes)}`);
    }

    // Fetch historical AE prices from CoinGecko (if converting to fiat)
    let aePriceHistory: Array<[number, number]> | null = null;
    if (convertTo !== 'ae') {
      // CoinGecko's /market_chart endpoint returns data relative to NOW, not a specific date range
      // So we need to request enough days to cover our date range from today
      const daysFromNow = moment().diff(start, 'days');
      // CoinGecko supports: 1, 7, 14, 30, 90, 180, 365, max
      // Request 365 days to ensure we get historical data (it will include our date range if it's within the last year)
      const days = 365;
      
      // Always use 'daily' interval from CoinGecko - hourly data is not reliably available
      // We'll use the closest daily price for any timestamp (including hourly requests)
      const priceInterval: 'daily' | 'hourly' = 'daily';

      this.logger.debug(`Fetching AE price history from CoinGecko: ${days} days (covering ${daysFromNow} days ago), ${priceInterval} interval, currency: ${convertTo}`);
      aePriceHistory = await this.coinGeckoService.fetchHistoricalPrice(
        AETERNITY_COIN_ID,
        convertTo,
        days,
        priceInterval,
      );

      if (aePriceHistory && aePriceHistory.length > 0) {
        // Note: CoinGecko returns last 365 days from today
        // We keep ALL price history (don't filter) so getAePriceAtTimestamp can use
        // the first/last price as fallback for dates outside CoinGecko's range
        const coinGeckoFirstMs = aePriceHistory[0][0];
        const coinGeckoLastMs = aePriceHistory[aePriceHistory.length - 1][0];
        const startMs = start.valueOf();
        const endMs = end.valueOf();
        
        // Log what we have vs what was requested
        if (endMs < coinGeckoFirstMs) {
          this.logger.warn(`Requested date range (${start.toISOString()} to ${end.toISOString()}) is before CoinGecko data starts (${moment(coinGeckoFirstMs).toISOString()}). Will use first available price for all timestamps.`);
        } else if (startMs > coinGeckoLastMs) {
          this.logger.warn(`Requested date range (${start.toISOString()} to ${end.toISOString()}) is after CoinGecko data ends (${moment(coinGeckoLastMs).toISOString()}). Will use last available price for all timestamps.`);
        }
        
        this.logger.log(`Using ${aePriceHistory.length} price points from CoinGecko. Range: ${moment(coinGeckoFirstMs).toISOString()} to ${moment(coinGeckoLastMs).toISOString()}, First price: ${aePriceHistory[0][1]} ${convertTo}, Last price: ${aePriceHistory[aePriceHistory.length - 1][1]} ${convertTo}`);
      } else {
        this.logger.error(`No AE price history fetched from CoinGecko for ${convertTo}. Fetched result: ${aePriceHistory ? 'null or empty array' : 'null'}. This will cause portfolio values to not fluctuate with AE price.`);
      }
    }

    // Calculate portfolio value for each timestamp
    const snapshots: PortfolioHistorySnapshot[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const timestamp = timestamps[i];
      const snapshot = await this.getPortfolioSnapshotAtTimestamp(
        address,
        accountTokens,
        timestamp,
        convertTo,
        allTransactions,
        aePriceHistory,
      );
      snapshots.push(snapshot);
      
      // Debug log for first, middle, and last snapshots
      if (i === 0 || i === Math.floor(timestamps.length / 2) || i === timestamps.length - 1) {
        this.logger.debug(`[${i}/${timestamps.length}] Snapshot at ${timestamp.toISOString()}: totalValueAe=${snapshot.total_value_ae.toFixed(6)}, totalValueUSD=${snapshot.total_value_usd?.toFixed(2) || 'N/A'} ${convertTo}`);
      }
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

    // Add converted value if requested (use current price from CoinGecko)
    if (convertTo !== 'ae') {
      try {
        const priceData = await this.coinGeckoService.getPriceData(new BigNumber(totalValueAe));
        const convertedValue = priceData[convertTo];
        if (convertedValue) {
          snapshot.total_value_usd = Number(convertedValue.toString());
        }
      } catch (error) {
        this.logger.warn(`Failed to convert portfolio value to ${convertTo}:`, error);
      }
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
    aePriceHistory?: Array<[number, number]> | null,
  ): Promise<PortfolioHistorySnapshot> {
    // Calculate historical AE balance
    const aeBalance = await this.getAEBalanceAtTimestamp(
      address,
      timestamp,
      allTransactions,
    );

    // Get all unique token sale addresses from transactions (includes tokens that were sold)
    // Exclude 'create_community' transactions as they don't represent token holdings
    const tokenSaleAddresses = new Set<string>();
    if (allTransactions) {
      for (const tx of allTransactions) {
        if (
          tx.sale_address &&
          tx.tx_type !== 'create_community' &&
          moment(tx.created_at).isSameOrBefore(timestamp)
        ) {
          tokenSaleAddresses.add(tx.sale_address);
        }
      }
      if (tokenSaleAddresses.size > 0) {
        this.logger.debug(`Found ${tokenSaleAddresses.size} unique token sale addresses from transactions at ${timestamp.toISOString()}`);
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
      if (!token) {
        this.logger.debug(`Token not found for sale_address ${saleAddress} at ${timestamp.toISOString()}`);
        continue;
      }

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
          const tokenValue = tokenBalance * tokenPrice;
          tokensValueAe += tokenValue;
          this.logger.debug(`Token ${saleAddress}: balance=${tokenBalance.toFixed(6)}, price=${tokenPrice.toFixed(8)} AE, value=${tokenValue.toFixed(6)} AE`);
        } else {
          this.logger.debug(`Token ${saleAddress}: balance=${tokenBalance.toFixed(6)} but price=0, skipping`);
        }
      } else {
        this.logger.debug(`Token ${saleAddress}: balance=0 at ${timestamp.toISOString()}`);
      }
    }

    const totalValueAe = aeBalance + tokensValueAe;

    const snapshot: PortfolioHistorySnapshot = {
      timestamp: timestamp.toDate(),
      total_value_ae: totalValueAe,
      ae_balance: aeBalance,
      tokens_value_ae: tokensValueAe,
    };

    // Convert to requested currency using historical AE price at this timestamp
    if (convertTo !== 'ae') {
      if (aePriceHistory && aePriceHistory.length > 0) {
        const aePriceAtTimestamp = this.getAePriceAtTimestamp(timestamp, aePriceHistory, convertTo);
        if (aePriceAtTimestamp > 0) {
          // Convert total value from AE to fiat currency
          snapshot.total_value_usd = totalValueAe * aePriceAtTimestamp;
        } else {
          // Fallback: use latest price if no historical price found
          this.logger.warn(`No AE price found for timestamp ${timestamp.toISOString()} (aePriceHistory length: ${aePriceHistory.length}), using totalValueAe as fallback`);
          snapshot.total_value_usd = totalValueAe;
        }
      } else {
        // No price history available at all
        this.logger.error(`No AE price history available for conversion to ${convertTo} at ${timestamp.toISOString()}. aePriceHistory: ${aePriceHistory ? `length=${aePriceHistory.length}` : 'null'}. Setting total_value_usd = total_value_ae.`);
        snapshot.total_value_usd = totalValueAe;
      }
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
    const transactions = await this.transactionRepository
      .createQueryBuilder('tx')
      .where('tx.address = :address', { address })
      .andWhere('tx.created_at <= :endDate', { endDate: endDate.toDate() })
      .orderBy('tx.created_at', 'ASC')
      .getMany();
    
    // Also check total transactions for this address (debug)
    const totalCount = await this.transactionRepository
      .createQueryBuilder('tx')
      .where('tx.address = :address', { address })
      .getCount();
    
    if (totalCount > transactions.length) {
      this.logger.warn(`Query filtered ${totalCount - transactions.length} transactions due to endDate=${endDate.toISOString()}. Total transactions for ${address}: ${totalCount}, filtered: ${transactions.length}`);
    }
    
    return transactions;
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
      this.logger.debug(`Calculating token balance for ${saleAddress} at ${timestamp.toISOString()}: found ${transactions.length} transactions`);
      for (const tx of transactions) {
        if (tx.tx_type === 'buy') {
          balance = balance.plus(tx.volume);
          this.logger.debug(`  Buy tx ${tx.tx_hash}: volume=${tx.volume.toString()}, new balance=${balance.toString()}`);
        } else if (tx.tx_type === 'sell') {
          balance = balance.minus(tx.volume);
          this.logger.debug(`  Sell tx ${tx.tx_hash}: volume=${tx.volume.toString()}, new balance=${balance.toString()}`);
        } else {
          this.logger.debug(`  Skipping tx ${tx.tx_hash}: type=${tx.tx_type}`);
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
      this.logger.debug(`Calculating AE balance for ${address} at ${timestamp.toISOString()}: current balance = ${toAe(balance.toString())} AE, transactions after: ${transactionsAfter.length}`);
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
              const balanceBefore = balance;
              if (tx.tx_type === 'buy') {
                // They spent AE, so add it back to get historical balance
                balance = balance.plus(aeAmountAettos);
                this.logger.debug(`  Buy tx ${tx.tx_hash} at ${moment(tx.created_at).toISOString()}: spent ${aeAmountValue} AE, balance ${toAe(balanceBefore.toString())} -> ${toAe(balance.toString())} AE`);
              } else if (tx.tx_type === 'sell') {
                // They received AE, so subtract it to get historical balance
                balance = balance.minus(aeAmountAettos);
                this.logger.debug(`  Sell tx ${tx.tx_hash} at ${moment(tx.created_at).toISOString()}: received ${aeAmountValue} AE, balance ${toAe(balanceBefore.toString())} -> ${toAe(balance.toString())} AE`);
              }
            } catch (error) {
              this.logger.warn(`Invalid AE amount in transaction ${tx.tx_hash}: ${aeAmountValue}`, error);
            }
          } else {
            this.logger.debug(`  Skipping tx ${tx.tx_hash}: invalid AE amount: ${aeAmountValue}`);
          }
        } else {
          this.logger.debug(`  Skipping tx ${tx.tx_hash}: no amount.ae field`);
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

  /**
   * Get AE price at a specific timestamp from historical price data
   * @param timestamp - The target timestamp (Moment object)
   * @param priceHistory - Array of [timestamp_ms, price] pairs from CoinGecko
   * @param currency - The currency code (usd, eur, etc.) - used for logging only
   * @returns The price at the timestamp, or 0 if not found
   */
  private getAePriceAtTimestamp(
    timestamp: Moment,
    priceHistory: Array<[number, number]>,
    currency: string,
  ): number {
    if (!priceHistory || priceHistory.length === 0) {
      this.logger.warn(`No price history available for currency ${currency}`);
      return 0;
    }

    // CoinGecko returns timestamps in milliseconds, convert our timestamp to match
    const targetTimeMs = timestamp.valueOf();

    // Find the closest price point (CoinGecko prices are sorted by timestamp)
    let closestPrice = 0;
    let minDiff = Infinity;
    let closestIndex = -1;

    for (let i = 0; i < priceHistory.length; i++) {
      const [priceTimeMs, price] = priceHistory[i];
      const diff = Math.abs(priceTimeMs - targetTimeMs);
      if (diff < minDiff) {
        minDiff = diff;
        closestPrice = price;
        closestIndex = i;
      }
      // Early exit optimization: if we've passed the target time, break (assuming sorted)
      if (priceTimeMs > targetTimeMs) {
        break;
      }
    }

    // Only return price if we found something reasonably close (within 24 hours)
    if (minDiff <= 24 * 60 * 60 * 1000) {
      return closestPrice;
    }

    // Fallback: use the first price if target is before all data, or last price if after
    if (targetTimeMs < priceHistory[0][0]) {
      this.logger.debug(`Timestamp ${timestamp.toISOString()} is before price history, using first price ${priceHistory[0][1]}`);
      return priceHistory[0][1];
    }
    if (targetTimeMs > priceHistory[priceHistory.length - 1][0]) {
      this.logger.debug(`Timestamp ${timestamp.toISOString()} is after price history, using last price ${priceHistory[priceHistory.length - 1][1]}`);
      return priceHistory[priceHistory.length - 1][1];
    }

    this.logger.warn(`Could not find AE price for timestamp ${timestamp.toISOString()}, minDiff: ${minDiff}ms (${(minDiff / (60 * 60 * 1000)).toFixed(1)} hours), closestIndex: ${closestIndex}, priceHistory range: ${moment(priceHistory[0][0]).toISOString()} to ${moment(priceHistory[priceHistory.length - 1][0]).toISOString()}`);
    return 0;
  }
}

