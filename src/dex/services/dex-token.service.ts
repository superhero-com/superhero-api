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
    debug = false,
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

    // Get all pairs to build the complete graph
    const allPairs = await this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .getMany();

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

    // Calculate price and liquidity for each path
    const pathAnalysis = paths.map((path: Pair[]) => {
      let price = '1';
      let totalLiquidity = 0;
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
        totalLiquidity += pairLiquidity;

        // Reduce confidence for longer paths
        confidence *= 0.9;
      }

      return {
        path,
        price,
        liquidity: totalLiquidity,
        confidence,
      };
    });

    // Sort by liquidity (highest first)
    pathAnalysis.sort((a, b) => b.liquidity - a.liquidity);

    const bestPath = pathAnalysis[0];
    const bestPrice = bestPath.price;

    // Calculate liquidity-weighted price
    const totalLiquidity = pathAnalysis.reduce(
      (sum, p) => sum + p.liquidity,
      0,
    );
    const liquidityWeightedPrice =
      pathAnalysis.length > 0
        ? pathAnalysis
            .reduce((sum, p) => {
              const weight = p.liquidity / totalLiquidity;
              return sum + parseFloat(p.price) * weight;
            }, 0)
            .toString()
        : bestPrice;

    // Calculate median price
    const prices = pathAnalysis
      .map((p) => parseFloat(p.price))
      .sort((a, b) => a - b);
    const medianPrice =
      prices.length > 0
        ? (prices.length % 2 === 0
            ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
            : prices[Math.floor(prices.length / 2)]
          ).toString()
        : bestPrice;

    // Calculate overall confidence based on liquidity and path quality
    const avgConfidence =
      pathAnalysis.reduce((sum, p) => sum + p.confidence, 0) /
      pathAnalysis.length;
    const liquidityFactor = Math.min(totalLiquidity / 1000, 1); // Normalize liquidity
    const overallConfidence = avgConfidence * liquidityFactor;

    const result = {
      price: bestPrice,
      confidence: overallConfidence,
      bestPath: bestPath.path,
      allPaths: pathAnalysis,
      liquidityWeightedPrice,
      medianPrice,
    };

    if (debug) {
      return result;
    }

    return {
      price: bestPrice,
      confidence: overallConfidence,
      bestPath: bestPath.path,
      allPaths: pathAnalysis,
      liquidityWeightedPrice,
      medianPrice,
    };
  }
}
