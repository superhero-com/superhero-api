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

type PriceAnalysisOptions = {
  allPairs?: Pair[];
};

@Injectable()
export class DexTokenService {
  private cachedPairs: Pair[] | null = null;
  private pairsCacheTime = 0;
  private static readonly PAIRS_CACHE_TTL_MS = 30_000;

  constructor(
    @InjectRepository(DexToken)
    private readonly dexTokenRepository: Repository<DexToken>,

    @InjectRepository(Pair)
    private readonly pairRepository: Repository<Pair>,
  ) {}

  async getAllPairsWithTokens(): Promise<Pair[]> {
    const now = Date.now();
    if (
      this.cachedPairs &&
      now - this.pairsCacheTime < DexTokenService.PAIRS_CACHE_TTL_MS
    ) {
      return this.cachedPairs;
    }
    this.cachedPairs = await this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .getMany();
    this.pairsCacheTime = now;
    return this.cachedPairs;
  }

  async findAll(
    options: IPaginationOptions,
    search: string = '',
    orderBy: string = 'created_at',
    orderDirection: 'ASC' | 'DESC' = 'DESC',
  ): Promise<Pagination<DexToken>> {
    const query = this.dexTokenRepository
      .createQueryBuilder('dexToken')
      .leftJoinAndSelect('dexToken.summary', 'summary');

    const allowedOrderFields = [
      'pairs_count',
      'name',
      'symbol',
      'created_at',
      'price',
      'tvl',
      '24hchange',
      '24hvolume',
      '7dchange',
      '7dvolume',
      '30dchange',
      '30dvolume',
    ];

    if (!allowedOrderFields.includes(orderBy)) {
      orderBy = 'created_at';
    }

    const allowedOrderDirections = ['ASC', 'DESC'];
    if (!allowedOrderDirections.includes(orderDirection)) {
      orderDirection = 'DESC';
    }

    if (orderBy) {
      // Handle special cases for JSON field ordering
      switch (orderBy) {
        case 'price':
          query.orderBy('("dexToken".price->>\'ae\')::numeric', orderDirection);
          break;
        case 'tvl':
          query.orderBy(
            '("summary".total_volume->>\'ae\')::numeric',
            orderDirection,
          );
          break;
        case '24hchange':
          query.orderBy(
            "(\"summary\".change->'24h'->>'percentage')::numeric",
            orderDirection,
          );
          break;
        case '24hvolume':
          query.orderBy(
            "(\"summary\".change->'24h'->'volume'->>'ae')::numeric",
            orderDirection,
          );
          break;
        case '7dchange':
          query.orderBy(
            "(\"summary\".change->'7d'->>'percentage')::numeric",
            orderDirection,
          );
          break;
        case '7dvolume':
          query.orderBy(
            "(\"summary\".change->'7d'->'volume'->>'ae')::numeric",
            orderDirection,
          );
          break;
        case '30dchange':
          query.orderBy(
            "(\"summary\".change->'30d'->>'percentage')::numeric",
            orderDirection,
          );
          break;
        case '30dvolume':
          query.orderBy(
            "(\"summary\".change->'30d'->'volume'->>'ae')::numeric",
            orderDirection,
          );
          break;
        default:
          query.orderBy(`"dexToken".${orderBy}`, orderDirection);
      }
    }

    if (search) {
      query.andWhere(
        '(dexToken.name ILIKE :search OR dexToken.symbol ILIKE :search)',
        {
          search: `%${search}%`,
        },
      );
    }

    return paginate(query, options);
  }

  async findByAddress(address: string): Promise<DexToken> {
    return this.dexTokenRepository
      .createQueryBuilder('dexToken')
      .leftJoinAndSelect('dexToken.summary', 'summary')
      .where('dexToken.address = :address', { address })
      .getOne();
  }

  async getTokenPrice(
    address: string,
    debug = false,
  ): Promise<{ price: string }> {
    const analysis = await this.getTokenPriceWithLiquidityAnalysis(
      address,
      DEX_CONTRACTS.wae,
      debug,
    );

    return { price: analysis?.medianPrice || '1' };
  }

  /**
   * Calculate the best token price by analyzing all possible liquidity paths
   * Uses liquidity-weighted pricing to get the most accurate price
   */
  async getTokenPriceWithLiquidityAnalysis(
    address: string,
    baseToken: string = DEX_CONTRACTS.wae,
    optionsOrLegacyDebug: boolean | PriceAnalysisOptions = {},
  ): Promise<{
    price: string;
    confidence: number;
    bestPath: Pair[];
    allPaths: Array<{
      path: Pair[];
      price: string;
      liquidity: number;
      confidence: number;
    }>;
    liquidityWeightedPrice: string;
    medianPrice: string;
  } | null> {
    if (address === baseToken) {
      return {
        price: '1',
        confidence: 1,
        bestPath: [],
        allPaths: [],
        liquidityWeightedPrice: '1',
        medianPrice: '1',
      };
    }

    const options =
      typeof optionsOrLegacyDebug === 'boolean' ? {} : optionsOrLegacyDebug;
    const allPairs = options.allPairs ?? (await this.getAllPairsWithTokens());

    // Build edges for path finding
    const edges = allPairs.map((pair) => ({
      data: pair,
      t0: pair.token0.address,
      t1: pair.token1.address,
    }));

    // Find all possible paths
    const paths = getPaths(address, baseToken, edges);

    if (!paths || paths.length === 0) {
      return null;
    }

    let bestPath: Pair[] = [];
    let bestPrice = '1';
    let bestLiquidity = -1;
    let totalLiquidity = 0;
    let weightedPriceSum = 0;
    let confidenceSum = 0;
    const prices: number[] = [];
    const pathAnalysis: Array<{
      path: Pair[];
      price: string;
      liquidity: number;
      confidence: number;
    }> = [];

    for (const path of paths) {
      let price = '1';
      let pathLiquidity = 0;
      let confidence = 1;

      // Calculate price by multiplying ratios along the path
      for (let i = 0; i < path.length; i++) {
        const pair = path[i];
        const isToken0 = pair.token0.address === address;
        const ratio = isToken0 ? pair.ratio1 : pair.ratio0;
        if (i === 0) {
          price = ratio.toString();
        } else {
          // For multi-hop paths, we need to adjust the calculation
          // This is a simplified approach - in practice, you'd need more complex logic
          price = (parseFloat(price) * parseFloat(ratio.toString())).toString();
        }

        // Calculate liquidity (using reserve values as proxy)
        const reserve0 = parseFloat(String(pair.reserve0 || '0'));
        const reserve1 = parseFloat(String(pair.reserve1 || '0'));
        const pairLiquidity = Math.min(reserve0, reserve1);
        pathLiquidity += pairLiquidity;

        // Reduce confidence for longer paths
        confidence *= 0.9;
      }

      if (pathLiquidity > bestLiquidity) {
        bestLiquidity = pathLiquidity;
        bestPath = path;
        bestPrice = price;
      }

      totalLiquidity += pathLiquidity;
      weightedPriceSum += parseFloat(price) * pathLiquidity;
      confidenceSum += confidence;
      prices.push(parseFloat(price));

      pathAnalysis.push({
        path,
        price,
        liquidity: pathLiquidity,
        confidence,
      });
    }

    pathAnalysis.sort((a, b) => b.liquidity - a.liquidity);

    const liquidityWeightedPrice =
      prices.length > 0
        ? totalLiquidity > 0
          ? (weightedPriceSum / totalLiquidity).toString()
          : bestPrice
        : bestPrice;

    // Calculate median price
    prices.sort((a, b) => a - b);
    const medianPrice =
      prices.length > 0
        ? (prices.length % 2 === 0
            ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
            : prices[Math.floor(prices.length / 2)]
          ).toString()
        : bestPrice;

    // Calculate overall confidence based on liquidity and path quality
    const avgConfidence = prices.length > 0 ? confidenceSum / prices.length : 0;
    const liquidityFactor = Math.min(totalLiquidity / 1000, 1); // Normalize liquidity
    const overallConfidence = avgConfidence * liquidityFactor;

    return {
      price: bestPrice,
      confidence: overallConfidence,
      bestPath,
      allPaths: pathAnalysis,
      liquidityWeightedPrice,
      medianPrice,
    };
  }
}
