import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DexToken } from '../entities/dex-token.entity';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';

@Injectable()
export class DexTokenService {
  constructor(
    @InjectRepository(DexToken)
    private readonly dexTokenRepository: Repository<DexToken>,
  ) {}

  async findAll(
    options: IPaginationOptions,
    orderBy: string = 'created_at',
    orderDirection: 'ASC' | 'DESC' = 'DESC',
  ): Promise<Pagination<DexToken>> {
    const query = this.dexTokenRepository.createQueryBuilder('dexToken');

    if (orderBy) {
      query.orderBy(`dexToken.${orderBy}`, orderDirection);
    }

    return paginate(query, options);
  }

  async findByAddress(address: string): Promise<DexToken> {
    return this.dexTokenRepository
      .createQueryBuilder('dexToken')
      .where('dexToken.address = :address', { address })
      .getOne();
  }
}
