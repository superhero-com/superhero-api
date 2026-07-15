import { AeSdkService } from '@/ae/ae-sdk.service';
import { Contract, Encoded } from '@aeternity/aepp-sdk';
import { BadRequestException, Injectable } from '@nestjs/common';
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
import { clampPaginationOptions } from '@/utils/pagination';

type ContractInstance = Awaited<ReturnType<typeof Contract.initialize>>;

type CachedContract = {
  instance: ContractInstance;
  lastUsedAt: number;
};

const ALLOWED_ORDER_BY = new Set(['transactions_count', 'created_at']);
const ALLOWED_ORDER_DIRECTIONS = new Set(['ASC', 'DESC']);

@Injectable()
export class PairService {
  private static readonly MAX_CACHED_CONTRACTS = 100;
  private contractCache: Record<Encoded.ContractAddress, CachedContract> = {};
  private cachedPathPairs: Pair[] | null = null;
  private pathPairsCacheTime = 0;
  private static readonly PATH_PAIRS_CACHE_TTL_MS = 30_000;
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
    if (!ALLOWED_ORDER_BY.has(orderBy)) {
      throw new BadRequestException(`Invalid order_by value: ${orderBy}`);
    }
    if (!ALLOWED_ORDER_DIRECTIONS.has(orderDirection)) {
      throw new BadRequestException(
        `Invalid order_direction value: ${orderDirection}`,
      );
    }
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

    // Bound page/limit (clamp, not reject) so the DEX list endpoints behave
    // consistently and a caller cannot force an unbounded scan + sort.
    return paginate(query, clampPaginationOptions(options));
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
    const now = Date.now();
    if (
      this.cachedPathPairs &&
      now - this.pathPairsCacheTime < PairService.PATH_PAIRS_CACHE_TTL_MS
    ) {
      return this.cachedPathPairs;
    }
    this.cachedPathPairs = await this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .leftJoinAndSelect('pair.summary', 'summary')
      .getMany();
    this.pathPairsCacheTime = now;
    return this.cachedPathPairs;
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
  private evictStalestContract(): void {
    const keys = Object.keys(this.contractCache);
    if (keys.length <= PairService.MAX_CACHED_CONTRACTS) return;
    let oldestKey = keys[0];
    let oldestTime = this.contractCache[oldestKey]?.lastUsedAt ?? 0;
    for (const key of keys) {
      const t = this.contractCache[key]?.lastUsedAt ?? 0;
      if (t < oldestTime) {
        oldestTime = t;
        oldestKey = key;
      }
    }
    delete this.contractCache[oldestKey];
  }

  async getPairContract(pair: Pair) {
    const cached = this.contractCache[pair.address];
    if (cached) {
      cached.lastUsedAt = Date.now();
      return cached.instance;
    }
    const pairContract = await Contract.initialize({
      ...this.aeSdkService.sdk.getContext(),
      aci: pairInterface,
      address: pair.address as Encoded.ContractAddress,
    });
    this.contractCache[pair.address] = {
      instance: pairContract,
      lastUsedAt: Date.now(),
    };
    this.evictStalestContract();
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
    // Guard against divide-by-zero on a dead/one-sided pool (0 reserves) — an
    // unguarded BigNumber div by 0 yields NaN/Infinity, which then poisons the
    // stored ratio. Matches the guard already used by the tx processor and sync.
    const reserve0Bn = new BigNumber(pair.reserve0);
    const reserve1Bn = new BigNumber(pair.reserve1);
    pair.ratio0 = reserve1Bn.gt(0) ? reserve0Bn.div(reserve1Bn).toNumber() : 0;
    pair.ratio1 = reserve0Bn.gt(0) ? reserve1Bn.div(reserve0Bn).toNumber() : 0;
    return this.pairRepository.save(pair);
  }
}
