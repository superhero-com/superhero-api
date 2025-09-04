import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Pair } from '../entities/pair.entity';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';

@Injectable()
export class PairService {
  constructor(
    @InjectRepository(Pair)
    private readonly pairRepository: Repository<Pair>,
  ) {}

  async findAll(
    options: IPaginationOptions,
    orderBy: string = 'created_at',
    orderDirection: 'ASC' | 'DESC' = 'DESC',
  ): Promise<Pagination<Pair>> {
    const query = this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .loadRelationCountAndMap('pair.transactions_count', 'pair.transactions');

    if (orderBy) {
      if (orderBy === 'transactions_count') {
        query.orderBy('pair.transactions_count', orderDirection);
      } else {
        query.orderBy(`pair.${orderBy}`, orderDirection);
      }
    }

    return paginate(query, options);
  }

  async findByAddress(address: string): Promise<Pair> {
    return this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .loadRelationCountAndMap('pair.transactions_count', 'pair.transactions')
      .where('pair.address = :address', { address })
      .getOne();
  }
}
