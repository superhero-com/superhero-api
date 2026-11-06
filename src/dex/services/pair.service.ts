import { AeSdkService } from '@/ae/ae-sdk.service';
import { Contract, Encoded } from '@aeternity/aepp-sdk';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import factoryInterface from 'dex-contracts-v2/build/AedexV2Factory.aci.json';
import pairInterface from 'dex-contracts-v2/build/AedexV2Pair.aci.json';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';
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
  private factoryContract: ContractInstance | null = null;
  // Factory pairs are never removed and their tokens never change, so both
  // caches only hold answers that stay true. They are bounded by the number of
  // pairs the factory has created.
  private factoryPairByTokens = new Map<string, string>();
  private pairTokens = new Map<string, { token0: string; token1: string }>();
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

  private async getFactoryContract(): Promise<ContractInstance> {
    if (!this.factoryContract) {
      this.factoryContract = await Contract.initialize({
        ...this.aeSdkService.sdk.getContext(),
        aci: factoryInterface,
        address: DEX_CONTRACTS.factory as Encoded.ContractAddress,
      });
    }
    return this.factoryContract;
  }

  /**
   * The pair the router uses for these two tokens, or null if the factory has
   * none.
   */
  async getFactoryPairAddress(
    tokenA: string,
    tokenB: string,
  ): Promise<string | null> {
    const key = [tokenA, tokenB].sort().join('|');
    const cached = this.factoryPairByTokens.get(key);
    if (cached) {
      return cached;
    }
    const factory = await this.getFactoryContract();
    const { decodedResult } = await factory.get_pair(tokenA, tokenB);
    if (!decodedResult) {
      return null;
    }
    this.factoryPairByTokens.set(key, decodedResult);
    return decodedResult;
  }

  async getFactoryPairAddresses(): Promise<Set<string>> {
    const factory = await this.getFactoryContract();
    const { decodedResult } = await factory.get_all_pairs();
    return new Set<string>(decodedResult);
  }

  /**
   * Token order as the pair stores it, which is the order of its reserves and
   * event amounts. Only pass factory pairs: any other contract can answer with
   * whatever tokens it likes.
   */
  async getPairTokens(
    pairAddress: string,
  ): Promise<{ token0: string; token1: string }> {
    const cached = this.pairTokens.get(pairAddress);
    if (cached) {
      return cached;
    }
    const pairContract = await this.getPairContract({
      address: pairAddress,
    } as Pair);
    const [token0, token1] = await Promise.all([
      pairContract.token0().then((res) => res.decodedResult),
      pairContract.token1().then((res) => res.decodedResult),
    ]);
    const tokens = { token0, token1 };
    this.pairTokens.set(pairAddress, tokens);
    return tokens;
  }

  /**
   * Re-reads a factory pair's token order and reserves from the chain.
   *
   * Rows used to take their tokens from the router call's arguments, so some
   * list them in the caller's order while reserves and stored event amounts
   * follow the pair's. Those rows get their tokens swapped back.
   */
  async syncPairFromChain(pair: Pair): Promise<Pair> {
    const { token0, token1 } = await this.getPairTokens(pair.address);
    const stored0 = pair.token0?.address;
    const stored1 = pair.token1?.address;
    if (stored0 === token1 && stored1 === token0) {
      // pullPairData saves the whole row, so the swapped relations persist
      // together with the fresh reserves.
      [pair.token0, pair.token1] = [pair.token1, pair.token0];
    } else if (stored0 !== token0 || stored1 !== token1) {
      throw new Error(
        `Pair ${pair.address} is stored as ${stored0}/${stored1} but holds ${token0}/${token1}`,
      );
    }
    return this.pullPairData(pair);
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
    // stored ratio. Matches the guard already used by the tx processor.
    const reserve0Bn = new BigNumber(pair.reserve0);
    const reserve1Bn = new BigNumber(pair.reserve1);
    pair.ratio0 = reserve1Bn.gt(0) ? reserve0Bn.div(reserve1Bn).toNumber() : 0;
    pair.ratio1 = reserve0Bn.gt(0) ? reserve1Bn.div(reserve0Bn).toNumber() : 0;
    return this.pairRepository.save(pair);
  }
}
