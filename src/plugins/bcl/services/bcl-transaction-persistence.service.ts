import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { BclTransaction } from '../entities/bcl-transaction.view';
import { TransactionData } from './transaction-data.service';
import moment from 'moment';

@Injectable()
export class BclTransactionPersistenceService {
  private readonly logger = new Logger(BclTransactionPersistenceService.name);

  constructor(
    @InjectRepository(BclTransaction)
    private readonly bclTransactionRepository: Repository<BclTransaction>,
  ) {}

  /**
   * Calculate verified field based on micro_time
   * Verified if transaction is at least 5 hours old
   */
  private calculateVerified(microTime: string | number): boolean {
    const microTimeNum = typeof microTime === 'string' ? parseInt(microTime, 10) : microTime;
    const hoursSinceTx = moment().diff(
      moment(microTimeNum / 1000),
      'hours',
    );
    return hoursSinceTx >= 5;
  }

  /**
   * Calculate sell_price from buy_price (buy_price * 0.995)
   */
  private calculateSellPrice(buyPrice: any): any {
    if (!buyPrice || typeof buyPrice !== 'object') {
      return null;
    }

    const sellPrice: any = {};
    for (const [key, value] of Object.entries(buyPrice)) {
      if (typeof value === 'number') {
        sellPrice[key] = value * 0.995;
      } else {
        sellPrice[key] = value;
      }
    }
    return sellPrice;
  }

  /**
   * Save BCL transaction record
   * @param tx - Raw transaction entity
   * @param txData - Transaction data from processor
   * @param manager - Optional entity manager for transaction context
   * @returns Saved BCL transaction entity
   */
  async saveBclTransaction(
    tx: Tx,
    txData: TransactionData,
    manager?: EntityManager,
  ): Promise<BclTransaction> {
    const repository = manager
      ? manager.getRepository(BclTransaction)
      : this.bclTransactionRepository;

    // Extract _version from tx.data?.bcl?._version or default to 1
    const _version = tx.data?.bcl?._version ?? 1;

    // Calculate verified field
    const verified = this.calculateVerified(tx.micro_time);

    // Calculate sell_price from buy_price (buy_price * 0.995)
    const sell_price = this.calculateSellPrice(txData.buy_price);

    // Convert micro_time to number
    const micro_time = typeof tx.micro_time === 'string' 
      ? parseInt(tx.micro_time, 10) 
      : tx.micro_time;

    // Prepare BCL transaction data
    
    const bclTransactionData: Partial<BclTransaction> = {
      hash: tx.hash,
      block_hash: tx.block_hash,
      block_height: tx.block_height,
      caller_id: tx.caller_id,
      function: tx.function || txData.tx_type,
      created_at: tx.created_at || txData.created_at,
      micro_time,
      amount: txData.amount,
      volume: txData.volume?.toString(),
      tx_type: txData.tx_type,
      buy_price: txData.buy_price,
      sell_price,
      market_cap: txData.market_cap,
      unit_price: txData.unit_price,
      previous_buy_price: txData.previous_buy_price,
      sale_address: txData.sale_address,
      total_supply: txData.total_supply?.toString(),
      protocol_reward: txData.protocol_reward?.toString(),
      _version,
      verified,
    };

    try {
      // Use upsert to handle race conditions
      await repository.upsert(bclTransactionData, {
        conflictPaths: ['hash'],
      });

      // Fetch and return the saved entity
      const savedTransaction = await repository.findOne({
        where: { hash: tx.hash },
      });

      if (!savedTransaction) {
        throw new Error(`Failed to create or retrieve BCL transaction ${tx.hash}`);
      }

      return savedTransaction;
    } catch (error: any) {
      this.logger.error(
        `Failed to save BCL transaction ${tx.hash}`,
        error.stack,
      );
      throw error;
    }
  }
}

