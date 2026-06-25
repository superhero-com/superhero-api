import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PairTransaction } from '../entities/pair-transaction.entity';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';

const ALLOWED_ORDER_BY = new Set(['created_at', 'tx_type']);
const ALLOWED_ORDER_DIRECTIONS = new Set(['ASC', 'DESC']);

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
    account_address?: string,
    tokenAddress?: string,
    fromDate?: string,
    toDate?: string,
  ): Promise<Pagination<PairTransaction>> {
    if (!ALLOWED_ORDER_BY.has(orderBy)) {
      throw new BadRequestException(`Invalid order_by value: ${orderBy}`);
    }
    if (!ALLOWED_ORDER_DIRECTIONS.has(orderDirection)) {
      throw new BadRequestException(
        `Invalid order_direction value: ${orderDirection}`,
      );
    }

    const parsedFromDate = this.parseDate(fromDate, 'from_date');
    const parsedToDate = this.parseDate(toDate, 'to_date');

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

    // Filter by account address if provided
    if (account_address) {
      query.andWhere('pairTransaction.account_address = :account_address', {
        account_address,
      });
    }

    // Filter by token address if provided
    if (tokenAddress) {
      query.andWhere(
        '(pair.token0.address = :tokenAddress OR pair.token1.address = :tokenAddress)',
        {
          tokenAddress,
        },
      );
    }

    // Filter by created_at time range if provided
    if (parsedFromDate) {
      query.andWhere('pairTransaction.created_at >= :fromDate', {
        fromDate: parsedFromDate,
      });
    }
    if (parsedToDate) {
      query.andWhere('pairTransaction.created_at <= :toDate', {
        toDate: parsedToDate,
      });
    }

    // Add ordering
    if (orderBy) {
      query.orderBy(`pairTransaction.${orderBy}`, orderDirection);
    }

    return paginate(query, options);
  }

  private parseDate(value: string | undefined, field: string): Date | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(
        `Invalid ${field} value: ${value}. Expected an ISO-8601 date string.`,
      );
    }
    return parsed;
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
