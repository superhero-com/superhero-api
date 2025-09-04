import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PairTransaction } from '../entities/pair-transaction.entity';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';

@Injectable()
export class PairTransactionService {
  constructor(
    @InjectRepository(PairTransaction)
    private readonly pairTransactionRepository: Repository<PairTransaction>,
  ) {}

  async findAll(
    options: IPaginationOptions,
    orderBy: string = 'created_at',
    orderDirection: 'ASC' | 'DESC' = 'DESC',
    pairAddress?: string,
    txType?: string,
  ): Promise<Pagination<PairTransaction>> {
    const query = this.pairTransactionRepository
      .createQueryBuilder('pairTransaction')
      .leftJoinAndSelect('pairTransaction.pair', 'pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1');

    // Filter by pair address if provided
    if (pairAddress) {
      query.andWhere('pair.address = :pairAddress', { pairAddress });
    }

    // Filter by transaction type if provided
    if (txType) {
      query.andWhere('pairTransaction.tx_type = :txType', { txType });
    }

    // Add ordering
    if (orderBy) {
      query.orderBy(`pairTransaction.${orderBy}`, orderDirection);
    }

    return paginate(query, options);
  }

  async findByTxHash(txHash: string): Promise<PairTransaction> {
    return this.pairTransactionRepository
      .createQueryBuilder('pairTransaction')
      .leftJoinAndSelect('pairTransaction.pair', 'pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .where('pairTransaction.tx_hash = :txHash', { txHash })
      .getOne();
  }

  async findByPairAddress(
    pairAddress: string,
    options: IPaginationOptions,
    orderBy: string = 'created_at',
    orderDirection: 'ASC' | 'DESC' = 'DESC',
  ): Promise<Pagination<PairTransaction>> {
    return this.findAll(options, orderBy, orderDirection, pairAddress);
  }
}
