import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import BigNumber from 'bignumber.js';
import { DexToken } from '../entities/dex-token.entity';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';
import { Pair } from '../entities/pair.entity';
import { getPaths } from '../utils/paths';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';
import { isSanePrice, MAX_SANE_PRICE } from '../utils/price-sanity';
import { humanAmount, isWae, priceScale } from '../utils/dex-math';
import { clampPaginationOptions } from '@/utils/pagination';

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
    listed?: boolean,
  ): Promise<Pagination<DexToken>> {
    const query = this.dexTokenRepository
      .createQueryBuilder('dexToken')
      .leftJoinAndSelect('dexToken.summary', 'summary');

    if (listed !== undefined) {
      query.andWhere('dexToken.listed = :listed', { listed });
    }

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

    // Bound page/limit so a caller cannot force an unbounded scan + sort.
    return paginate(query, clampPaginationOptions(options));
  }

  /**
   * Find the most relevant pair to chart a single token's price.
   * Prefers a pair quoted against WAE (so the price is expressed in AE),
   * and among the candidates picks the one with the deepest liquidity.
   * Returns the pair plus the position ('token0' | 'token1') of the quote
   * (base) token, which callers pass as `fromToken` to PairHistoryService so
   * the resulting price series is the requested token priced in the base token.
   */
  async findBestPairForToken(
    tokenAddress: string,
  ): Promise<{ pair: Pair; basePosition: 'token0' | 'token1' } | null> {
    // Targeted lookup: only the pairs that contain this token, instead of
    // loading the entire pairs table into memory on every chart request.
    const candidates = await this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .where(
        'token0.address = :tokenAddress OR token1.address = :tokenAddress',
        { tokenAddress },
      )
      .getMany();
    if (candidates.length === 0) {
      return null;
    }

    // Liquidity-depth proxy: the smaller of the two reserves, normalised to
    // human units by each token's decimals so pools with different-decimal
    // tokens are compared apples-to-apples. Used to pick the deepest charting
    // pool (after the WAE-preference below, which is what actually matters).
    const liquidity = (pair: Pair) => {
      const r0 = humanAmount(pair.reserve0, pair.token0?.decimals);
      const r1 = humanAmount(pair.reserve1, pair.token1?.decimals);
      return BigNumber.min(r0, r1).toNumber();
    };

    const isWaePair = (pair: Pair) =>
      isWae(pair.token0?.address) || isWae(pair.token1?.address);

    // Prefer a WAE pair so the series is AE-denominated — but only among WAE
    // pools that actually have liquidity. Otherwise an empty/zero-liquidity WAE
    // pool would be chosen over an active non-WAE pool, producing useless or
    // empty charts. With no liquid WAE pool, fall back to the deepest pool among
    // all candidates.
    // Preference order:
    //  1. liquid WAE pools → AE-denominated and tradeable (best charts/prices)
    //  2. any liquid pool  → non-WAE, but at least has real liquidity
    //  3. dead WAE pools   → every pool is drained: still prefer a WAE pair so
    //                        the last-known price / chart stays AE-denominated
    //                        instead of depending on query order
    //  4. anything left    → all dead and none against WAE
    const liquidWaePairs = candidates.filter(
      (candidate) => isWaePair(candidate) && liquidity(candidate) > 0,
    );
    const liquidPairs = candidates.filter(
      (candidate) => liquidity(candidate) > 0,
    );
    const waePairs = candidates.filter(isWaePair);
    const pool =
      liquidWaePairs.length > 0
        ? liquidWaePairs
        : liquidPairs.length > 0
          ? liquidPairs
          : waePairs.length > 0
            ? waePairs
            : candidates;

    const pair = pool.reduce((best, current) =>
      liquidity(current) > liquidity(best) ? current : best,
    );

    // The base (quote) token is the one that is NOT the requested token.
    const basePosition: 'token0' | 'token1' =
      pair.token0?.address === tokenAddress ? 'token1' : 'token0';

    return { pair, basePosition };
  }

  /**
   * Last traded AE price of a token, from the most recent transaction of its
   * best WAE pair. Used only as a fallback when every live pool is dead/drained,
   * so a delisted/illiquid token shows its last real price (matching the chart)
   * instead of the misleading 1 AE default. Returns null when the token has no
   * AE-quoted pair history.
   */
  private async getLastKnownPrice(
    address: string,
    baseToken: string,
  ): Promise<string | null> {
    const best = await this.findBestPairForToken(address);
    if (!best) {
      return null;
    }
    const value = best.basePosition === 'token0' ? '0' : '1';
    const baseTok = value === '0' ? best.pair.token0 : best.pair.token1;
    const quoteTok = value === '0' ? best.pair.token1 : best.pair.token0;
    // Only a WAE-quoted price is denominated in AE; a non-WAE base would yield a
    // price in some other token, not AE — so we can't use it for the AE price.
    if (baseTok?.address !== baseToken) {
      return null;
    }
    // Stored ratio is RAW (reserve ratio); a human AE price is
    // ratio * 10^(quoteDecimals - baseDecimals). Bound the RAW ratio in SQL so
    // dust-state transactions (a near-drained pool — e.g. 1 wei of a token —
    // whose normalized price is absurd, like 1 token = 2e18 AE) are skipped,
    // and we take the most recent SANE trade. That matches the chart instead of
    // reporting a dust price or nothing.
    const scale = priceScale(quoteTok?.decimals, baseTok?.decimals);
    const rawBound = new BigNumber(MAX_SANE_PRICE).dividedBy(scale);
    const rows = await this.pairRepository.manager.query(
      `SELECT ratio${value} AS ratio
         FROM pair_transactions
        WHERE pair_address = $1
          AND ratio${value} IS NOT NULL
          AND ratio${value} != 'NaN'
          AND ABS(CAST(ratio${value} AS decimal)) < CAST($2 AS decimal)
        ORDER BY created_at DESC
        LIMIT 1`,
      [best.pair.address, rawBound.toFixed()],
    );
    const raw = rows?.[0]?.ratio;
    if (raw == null) {
      return null;
    }
    const price = new BigNumber(String(raw)).multipliedBy(scale);
    return isSanePrice(price) && price.gt(0) ? price.toString() : null;
  }

  async findByAddress(address: string): Promise<DexToken | null> {
    return this.dexTokenRepository
      .createQueryBuilder('dexToken')
      .leftJoinAndSelect('dexToken.summary', 'summary')
      .where('dexToken.address = :address', { address })
      .getOne();
  }

  /** Toggle the curated "listed" flag for a token. Returns the updated token. */
  async setListed(address: string, listed: boolean): Promise<DexToken | null> {
    const token = await this.dexTokenRepository.findOne({ where: { address } });
    if (!token) {
      return null;
    }
    token.listed = listed;
    return this.dexTokenRepository.save(token);
  }

  async getTokenPrice(
    address: string,
    debug = false,
  ): Promise<{ price: string | null }> {
    const analysis = await this.getTokenPriceWithLiquidityAnalysis(
      address,
      DEX_CONTRACTS.wae,
      debug,
    );

    // Use the deepest-liquidity path price, not the median: the median is
    // corrupted by dust/dead pools and multi-hop outliers. `null` means the
    // token has no AE-denominated price (no liquid path to WAE) — surfaced as-is
    // so the client renders "no price" instead of a fake 1 AE.
    return { price: analysis?.price ?? null };
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
    price: string | null;
    confidence: number;
    bestPath: Pair[];
    allPaths: Array<{
      path: Pair[];
      price: string;
      liquidity: number;
      confidence: number;
    }>;
    liquidityWeightedPrice: string | null;
    medianPrice: string | null;
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
    // Prefer a DIRECT pool against the base token (a 1-hop path to WAE) over a
    // deeper multi-hop route. That direct pool is what users actually swap AE
    // against and what the chart (findBestPairForToken) shows, so the displayed
    // price stays consistent with the swap quote and the chart. Multi-hop is
    // only used as a fallback when no direct base pool exists.
    let bestIsDirect = false;
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
      let price = new BigNumber(1);
      // Path liquidity is the BOTTLENECK (a path is only as deep as its
      // shallowest pool), not the sum of all hops.
      let pathLiquidity = Infinity;
      let confidence = 1;
      let currentToken = address;
      let valid = true;

      // Walk the path, tracking the "current" token so each hop uses the
      // correct ratio direction (the old code used the original token at every
      // hop, which broke multi-hop prices).
      for (const pair of path) {
        const currentIsToken0 = pair.token0?.address === currentToken;
        const currentTok = currentIsToken0 ? pair.token0 : pair.token1;
        const nextTok = currentIsToken0 ? pair.token1 : pair.token0;

        // Stored ratio is "next-token per current-token" in RAW units. Normalise
        // to human units by the two tokens' decimals — otherwise a hop between
        // tokens of different decimals is off by 10^(decCurrent - decNext).
        const rawRatio = new BigNumber(
          String((currentIsToken0 ? pair.ratio1 : pair.ratio0) ?? '0'),
        );
        const currentReserve = humanAmount(
          currentIsToken0 ? pair.reserve0 : pair.reserve1,
          currentTok?.decimals,
        );
        const nextReserve = humanAmount(
          currentIsToken0 ? pair.reserve1 : pair.reserve0,
          nextTok?.decimals,
        );

        // Drop the whole path if any hop is a dead/empty pool or has an unusable
        // ratio — such pools yield garbage prices that would poison the result.
        if (
          !rawRatio.isFinite() ||
          rawRatio.lte(0) ||
          currentReserve.lte(0) ||
          nextReserve.lte(0)
        ) {
          valid = false;
          break;
        }

        const decimalScale = priceScale(
          currentTok?.decimals,
          nextTok?.decimals,
        );
        price = price.multipliedBy(rawRatio.multipliedBy(decimalScale));
        pathLiquidity = Math.min(
          pathLiquidity,
          BigNumber.min(currentReserve, nextReserve).toNumber(),
        );
        currentToken = nextTok?.address;
        confidence *= 0.9;
      }

      if (!valid) {
        continue;
      }
      // A dust pool (e.g. 1 wei of a token against 2 WAE) passes the reserve > 0
      // check above but yields an absurd price (1 token = 2e18 AE). Reject any
      // path whose computed price is outside the sane range so a degenerate pool
      // cannot define the token's price; we then fall back to the last sane
      // traded price below.
      if (!isSanePrice(price)) {
        continue;
      }
      if (!Number.isFinite(pathLiquidity)) {
        pathLiquidity = 0;
      }

      const priceStr = price.toString();
      const priceNum = price.toNumber();

      // A length-1 path is a direct pool against the base token (WAE).
      const isDirect = path.length === 1;
      const isBetter =
        (isDirect && !bestIsDirect) ||
        (isDirect === bestIsDirect && pathLiquidity > bestLiquidity);
      if (isBetter) {
        bestIsDirect = isDirect;
        bestLiquidity = pathLiquidity;
        bestPath = path;
        bestPrice = priceStr;
      }

      totalLiquidity += pathLiquidity;
      weightedPriceSum += priceNum * pathLiquidity;
      confidenceSum += confidence;
      prices.push(priceNum);

      pathAnalysis.push({
        path,
        price: priceStr,
        liquidity: pathLiquidity,
        confidence,
      });
    }

    // No path had live liquidity (every pool is dead/drained). Rather than
    // report the misleading 1 AE default, fall back to the LAST TRADED price
    // from the most recent transaction of the token's best WAE pair — the same
    // value the chart's latest candle shows. Leaves the '1' default only when
    // there is no AE-quoted history at all.
    if (pathAnalysis.length === 0) {
      const lastKnown = await this.getLastKnownPrice(address, baseToken);
      if (lastKnown) {
        return {
          price: lastKnown,
          confidence: 0,
          bestPath: [],
          allPaths: [],
          liquidityWeightedPrice: lastKnown,
          medianPrice: lastKnown,
        };
      }
    }

    pathAnalysis.sort((a, b) => b.liquidity - a.liquidity);

    // No path priced the token and no sane last-known AE trade exists — the
    // token has NO AE-denominated price (e.g. its only liquidity is against a
    // non-AE token). Return null rather than the misleading 1 AE placeholder so
    // callers can render "no price" instead of a fake value.
    const hasPrices = prices.length > 0;

    const liquidityWeightedPrice = hasPrices
      ? totalLiquidity > 0
        ? (weightedPriceSum / totalLiquidity).toString()
        : bestPrice
      : null;

    // Calculate median price
    prices.sort((a, b) => a - b);
    const medianPrice = hasPrices
      ? (prices.length % 2 === 0
          ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
          : prices[Math.floor(prices.length / 2)]
        ).toString()
      : null;

    // Calculate overall confidence based on liquidity and path quality
    const avgConfidence = prices.length > 0 ? confidenceSum / prices.length : 0;
    const liquidityFactor = Math.min(totalLiquidity / 1000, 1); // Normalize liquidity
    const overallConfidence = avgConfidence * liquidityFactor;

    return {
      price: hasPrices ? bestPrice : null,
      confidence: overallConfidence,
      bestPath,
      allPaths: pathAnalysis,
      liquidityWeightedPrice,
      medianPrice,
    };
  }
}
