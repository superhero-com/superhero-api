import { AeSdkService } from '@/ae/ae-sdk.service';
import { Contract, Encoded } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import pairInterface from 'dex-contracts-v2/build/AedexV2Pair.aci.json';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { Pair } from '../entities/pair.entity';
import { getPaths } from '../utils/paths';

type ContractInstance = Awaited<ReturnType<typeof Contract.initialize>>;

@Injectable()
export class PairService {
  contracts: Record<
    Encoded.ContractAddress,
    ContractInstance
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
    search?: string,
    token_address?: string,
  ): Promise<Pagination<Pair>> {
    const query = this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .leftJoinAndSelect('pair.summary', 'summary')
      .loadRelationCountAndMap('pair.transactions_count', 'pair.transactions');

    if (orderBy) {
      if (orderBy === 'transactions_count') {
        // Order by the count of related transactions using a subquery
        query.orderBy(
          `(SELECT COUNT(pt.tx_hash) FROM pair_transactions pt WHERE pt.pair_address = pair.address)`,
          orderDirection,
        );
      } else {
        query.orderBy(`pair.${orderBy}`, orderDirection);
      }
    }

    if (search) {
      query.andWhere(
        '(token0.name ILIKE :search OR token0.symbol ILIKE :search OR token1.name ILIKE :search OR token1.symbol ILIKE :search)',
        {
          search: `%${search}%`,
        },
      );
    }

    if (token_address) {
      query.andWhere(
        '(token0.address = :token_address OR token1.address = :token_address)',
        {
          token_address,
        },
      );
    }

    return paginate(query, options);
  }

  async findByAddress(address: string): Promise<Pair> {
    return this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .leftJoinAndSelect('pair.summary', 'summary')
      .loadRelationCountAndMap('pair.transactions_count', 'pair.transactions')
      .where('pair.address = :address', { address })
      .getOne();
  }

  async findByFromTokenAndToToken(
    fromToken: string,
    toToken: string,
  ): Promise<Pair> {
    return this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .leftJoinAndSelect('pair.summary', 'summary')
      .where(
        '(token0.address = :fromToken AND token1.address = :toToken) OR (token0.address = :toToken AND token1.address = :fromToken)',
        { fromToken, toToken },
      )
      .getOne();
  }

  async findPairsForTokens(
    fromToken: string,
    toToken: string,
  ): Promise<Pair[]> {
    return this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .leftJoinAndSelect('pair.summary', 'summary')
      .where(
        '(token0.address = :fromToken AND token1.address = :toToken) OR (token0.address = :toToken AND token1.address = :fromToken)',
        { fromToken, toToken },
      )
      .getMany();
  }

  async getAllPairsForPathFinding(): Promise<Pair[]> {
    return this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .leftJoinAndSelect('pair.summary', 'summary')
      .getMany();
  }

  async findSwapPaths(
    fromToken: string,
    toToken: string,
  ): Promise<{ paths: Pair[][]; directPairs: Pair[] }> {
    // Get all pairs to build the complete graph
    const allPairs = await this.getAllPairsForPathFinding();

    // Check for direct pairs
    const directPairs = allPairs.filter(
      (pair) =>
        (pair.token0.address === fromToken &&
          pair.token1.address === toToken) ||
        (pair.token0.address === toToken && pair.token1.address === fromToken),
    );

    // Build edges for path finding
    const edges = allPairs.map((pair) => ({
      data: pair,
      t0: pair.token0.address,
      t1: pair.token1.address,
    }));

    // Find all possible paths (including direct and multi-hop)
    const paths = getPaths(fromToken, toToken, edges);

    return {
      paths,
      directPairs,
    };
  }
  async getPairContract(pair: Pair) {
    if (this.contracts[pair.address]) {
      return this.contracts[pair.address];
    }
    const pairContract = await Contract.initialize({
      ...this.aeSdkService.sdk.getContext(),
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
    pair.ratio0 = new BigNumber(pair.reserve0).div(pair.reserve1).toNumber();
    pair.ratio1 = new BigNumber(pair.reserve1).div(pair.reserve0).toNumber();
    return this.pairRepository.save(pair);
  }
}
