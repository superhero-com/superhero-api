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
  ) { }

  async findAll(
    options: IPaginationOptions,
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

    return paginate(query, options);
  }

  async findByAddress(address: string): Promise<DexToken> {
    return this.dexTokenRepository
      .createQueryBuilder('dexToken')
      .where('dexToken.address = :address', { address })
      .getOne();
  }

  async getTokenPrice(address: string): Promise<any> {
    const pairs = await this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .getMany();
    const edges = pairs.map((pair) => {
      return {
        data: pair,
        t0: pair.token0.address,
        t1: pair.token1.address,
      };
    });
    const paths = getPaths(address, DEX_CONTRACTS.wae, edges);
    const price = paths.reduce((acc, path) => {
      return acc.add(path.reduce((acc, p) => {
        return acc.add(p.ratio0.div(p.ratio1));
      }, new BigNumber(0)));
    }, new BigNumber(0));
    // const priceData = await this.aePricingService.getPriceData(price);
    return { price, paths,  };
  }
}
