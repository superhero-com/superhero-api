import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';
import { BclTransaction } from '../entities/bcl-transaction.view';
import { BclTransactionDto } from '../dto/bcl-transaction.dto';

@Injectable()
export class BclTransactionsService {
  constructor(
    @InjectRepository(BclTransaction)
    private readonly bclTransactionRepository: Repository<BclTransaction>,
  ) {}

  async findAll(
    options: IPaginationOptions,
    filters?: {
      token_address?: string;
      account_address?: string;
    },
  ): Promise<Pagination<BclTransactionDto> & { queryMs: number }> {
    const queryBuilder = this.bclTransactionRepository
      .createQueryBuilder('bcl_transaction')
      .orderBy('bcl_transaction.created_at', 'DESC');

    if (filters?.token_address) {
      queryBuilder.where('bcl_transaction.sale_address = :sale_address', {
        sale_address: filters.token_address,
      });
    }

    if (filters?.account_address) {
      if (filters?.token_address) {
        queryBuilder.andWhere('bcl_transaction.caller_id = :account_address', {
          account_address: filters.account_address,
        });
      } else {
        queryBuilder.where('bcl_transaction.caller_id = :account_address', {
          account_address: filters.account_address,
        });
      }
    }

    const startTime = Date.now();
    const paginationResult = await paginate<BclTransaction>(
      queryBuilder,
      options,
    );
    const queryMs = Date.now() - startTime;

    // Transform to DTO format
    const items = paginationResult.items.map((item) => this.toDto(item));

    return {
      ...paginationResult,
      items,
      queryMs, 
    };
  }

  private toDto(transaction: BclTransaction): BclTransactionDto {
    return {
      tx_hash: transaction.hash,
      sale_address: transaction.sale_address || '',
      tx_type: transaction.tx_type || transaction.function,
      block_height: transaction.block_height,
      verified: transaction.verified,
      address: transaction.caller_id || '',
      volume: transaction.volume || '0',
      protocol_reward: transaction.protocol_reward || '0',
      amount: transaction.amount || {},
      unit_price: transaction.unit_price || {},
      previous_buy_price: transaction.previous_buy_price,
      buy_price: transaction.buy_price || {},
      sell_price: transaction.sell_price,
      total_supply: transaction.total_supply || '0',
      market_cap: transaction.market_cap,
      created_at: transaction.created_at,
    };
  }
}

