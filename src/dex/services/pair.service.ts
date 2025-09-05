import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Pair } from '../entities/pair.entity';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';
import { AeSdkService } from '@/ae/ae-sdk.service';
import ContractWithMethods, {
  ContractMethodsBase,
} from '@aeternity/aepp-sdk/es/contract/Contract';
import { Encoded } from '@aeternity/aepp-sdk';
import pairInterface from 'dex-contracts-v2/build/AedexV2Pair.aci.json';

@Injectable()
export class PairService {
  contracts: Record<
    Encoded.ContractAddress,
    ContractWithMethods<ContractMethodsBase>
  > = {};
  constructor(
    @InjectRepository(Pair)
    private readonly pairRepository: Repository<Pair>,

    private aeSdkService: AeSdkService,
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

  async getPairContract(pair: Pair) {
    if (this.contracts[pair.address]) {
      return this.contracts[pair.address];
    }
    const pairContract = await this.aeSdkService.sdk.initializeContract({
      aci: pairInterface,
      address: pair.address as Encoded.ContractAddress,
    });
    this.contracts[pair.address] = pairContract;
    return pairContract;
  }

  async pullPairData(pair: Pair) {
    const pairContract = await this.getPairContract(pair);
    const [total_supply, reserves] = await Promise.all([
      pairContract.total_supply().then((res) => res.decodedResult),
      pairContract.get_reserves().then((res) => res.decodedResult),
    ]);

    pair.total_supply = total_supply?.toString() || '0';
    pair.reserve0 = reserves.reserve0?.toString() || '0';
    pair.reserve1 = reserves.reserve1?.toString() || '0';
    return this.pairRepository.save(pair);
  }
}
