import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DexToken } from '../entities/dex-token.entity';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';
import { Pair } from '../entities/pair.entity';
import { getPaths } from '../utils/paths';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';
import BigNumber from 'bignumber.js';

@Injectable()
export class DexTokenService {
  constructor(
    @InjectRepository(DexToken)
    private readonly dexTokenRepository: Repository<DexToken>,

    @InjectRepository(Pair)
    private readonly pairRepository: Repository<Pair>,
  ) {}

  async findAll(
    options: IPaginationOptions,
    search: string = '',
    orderBy: string = 'created_at',
    orderDirection: 'ASC' | 'DESC' = 'DESC',
  ): Promise<Pagination<DexToken>> {
    const query = this.dexTokenRepository.createQueryBuilder('dexToken');
    const allowedOrderFields = ['pairs_count', 'name', 'symbol', 'created_at'];
    if (!allowedOrderFields.includes(orderBy)) {
      orderBy = 'created_at';
    }
    const allowedOrderDirections = ['ASC', 'DESC'];
    if (!allowedOrderDirections.includes(orderDirection)) {
      orderDirection = 'DESC';
    }
    if (orderBy) {
      query.orderBy(`dexToken.${orderBy}`, orderDirection);
    }

    if (search) {
      query.andWhere('dexToken.name ILIKE :search', {
        search: `%${search}%`,
      });
    }

    return paginate(query, options);
  }

  async findByAddress(address: string): Promise<DexToken> {
    return this.dexTokenRepository
      .createQueryBuilder('dexToken')
      .where('dexToken.address = :address', { address })
      .getOne();
  }

  async getTokenPrice(
    address: string,
    debug = false,
  ): Promise<{ price: string }> {
    const pairs = await this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .getMany();
    return this.getTokenPriceFromPairs(address, pairs, debug);
  }

  getTokenPriceFromPairs(
    address: string,
    pairs: Pair[],
    debug = false,
  ): { price: string; firstPath?: any; paths?: any[] } {
    if (address === DEX_CONTRACTS.wae) {
      return { price: '1' };
    }
    const edges = pairs.map((pair) => {
      return {
        data: pair,
        t0: pair.token0.address,
        t1: pair.token1.address,
      };
    });
    const paths = getPaths(address, DEX_CONTRACTS.wae, edges);
    const firstPath: any = paths?.[0]?.[0];

    if (!firstPath) {
      return null;
    }
    const price =
      firstPath.token0.address === address
        ? firstPath.ratio1
        : firstPath.ratio0;

    if (debug) {
      return { price, firstPath, paths };
    }
    return { price };
  }
}
