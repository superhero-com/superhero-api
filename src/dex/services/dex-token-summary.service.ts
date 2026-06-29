import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DexToken } from '../entities/dex-token.entity';
import { Pair } from '../entities/pair.entity';
import { DexTokenSummary } from '../entities/dex-token-summary.entity';
import moment from 'moment';
import BigNumber from 'bignumber.js';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { DexTokenService } from './dex-token.service';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';
import { isSanePrice } from '../utils/price-sanity';
import {
  humanAmount,
  isWae,
  priceScale as priceScaleOf,
} from '../utils/dex-math';

type SummaryComputationOptions = {
  allPairs?: Pair[];
  priceCache?: Map<string, Promise<string | null>>;
};

@Injectable()
export class DexTokenSummaryService {
  constructor(
    @InjectRepository(DexTokenSummary)
    private readonly dexTokenSummaryRepository: Repository<DexTokenSummary>,

    @InjectRepository(DexToken)
    private readonly dexTokenRepository: Repository<DexToken>,

    @InjectRepository(Pair)
    private readonly pairRepository: Repository<Pair>,

    @InjectDataSource() private readonly dataSource: DataSource,

    private readonly aePricingService: AePricingService,
    private readonly dexTokenService: DexTokenService,
  ) {}

  private async getPairsForToken(
    tokenAddress: string,
    allPairs?: Pair[],
  ): Promise<Pair[]> {
    if (allPairs) {
      return allPairs.filter(
        (pair) =>
          pair.token0.address === tokenAddress ||
          pair.token1.address === tokenAddress,
      );
    }

    return this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .where('token0.address = :addr OR token1.address = :addr', {
        addr: tokenAddress,
      })
      .getMany();
  }

  private async getMedianTokenPrice(
    tokenAddress: string,
    options: SummaryComputationOptions,
  ): Promise<string | null> {
    if (isWae(tokenAddress)) {
      return '1';
    }

    const cachedPrice = options.priceCache?.get(tokenAddress);
    if (cachedPrice) {
      return cachedPrice;
    }

    const pricePromise = this.dexTokenService
      .getTokenPriceWithLiquidityAnalysis(tokenAddress, DEX_CONTRACTS.wae, {
        allPairs: options.allPairs,
      })
      // Use the deepest-liquidity path price, not the median: the median is
      // poisoned by dust/dead pools and multi-hop outliers (the same bug fixed
      // in getTokenPrice).
      .then((analysis) => analysis?.price ?? null)
      .catch((error) => {
        options.priceCache?.delete(tokenAddress);
        throw error;
      });

    options.priceCache?.set(tokenAddress, pricePromise);
    return pricePromise;
  }

  async createOrUpdateSummary(
    tokenAddress: string,
    options: SummaryComputationOptions = {},
  ): Promise<DexTokenSummary> {
    const token = await this.dexTokenRepository.findOne({
      where: { address: tokenAddress },
    });
    if (!token) {
      return null;
    }

    const summaryOptions: SummaryComputationOptions = {
      ...options,
      priceCache:
        options.priceCache ?? new Map<string, Promise<string | null>>(),
    };
    const pairs = await this.getPairsForToken(
      tokenAddress,
      summaryOptions.allPairs,
    );

    const queryRunner = this.dataSource.createQueryRunner();

    try {
      const currentPrice = await this.getMedianTokenPrice(
        tokenAddress,
        summaryOptions,
      );

      const now = moment();
      const periods: Record<string, moment.Moment> = {
        '24h': now.clone().subtract(24, 'hours'),
        '7d': now.clone().subtract(7, 'days'),
        '30d': now.clone().subtract(30, 'days'),
      };

      // Raw per-pair volume sums for the all-time total and each period window,
      // fetched in ONE grouped query instead of P×4 per-pair queries. The
      // decimal/price conversion is done in JS below using the in-memory token
      // decimals — so we can drop the pairs/dex_tokens joins entirely and avoid
      // SQL float division (POW(10,…) is double precision), keeping full
      // BigNumber precision.
      const pairAddresses = pairs.map((p) => p.address);
      let rawRows: any[] = [];
      if (pairAddresses.length > 0) {
        rawRows = await queryRunner.query(
          `
            SELECT
              pt.pair_address AS pair_address,
              COALESCE(SUM(pt.volume0), 0) AS vol0_total,
              COALESCE(SUM(pt.volume1), 0) AS vol1_total,
              COALESCE(SUM(pt.volume0) FILTER (WHERE pt.created_at >= $2), 0) AS vol0_24h,
              COALESCE(SUM(pt.volume1) FILTER (WHERE pt.created_at >= $2), 0) AS vol1_24h,
              COALESCE(SUM(pt.volume0) FILTER (WHERE pt.created_at >= $3), 0) AS vol0_7d,
              COALESCE(SUM(pt.volume1) FILTER (WHERE pt.created_at >= $3), 0) AS vol1_7d,
              COALESCE(SUM(pt.volume0) FILTER (WHERE pt.created_at >= $4), 0) AS vol0_30d,
              COALESCE(SUM(pt.volume1) FILTER (WHERE pt.created_at >= $4), 0) AS vol1_30d
            FROM pair_transactions pt
            WHERE pt.pair_address = ANY($1)
              AND pt.tx_type IN (
                'swap_exact_tokens_for_tokens',
                'swap_tokens_for_exact_tokens',
                'swap_exact_tokens_for_ae',
                'swap_tokens_for_exact_ae',
                'swap_exact_ae_for_tokens',
                'swap_ae_for_exact_tokens'
              )
            GROUP BY pt.pair_address
          `,
          [
            pairAddresses,
            periods['24h'].toDate(),
            periods['7d'].toDate(),
            periods['30d'].toDate(),
          ],
        );
      }
      const rawByPair = new Map<string, any>(
        rawRows.map((r) => [r.pair_address, r]),
      );

      // Convert a pair's raw (volume0, volume1) sums to an AE amount, mirroring
      // the previous SQL CASE logic exactly:
      //  - AEX9/AEX9 pair: the token side in human units × the token's AE price
      //    (skipped — contributes 0 — when no price is available).
      //  - WAE pair: the WAE leg taken directly (dust-safe; never reconstructed
      //    via the per-tx reserve ratio).
      const convertPairVolumeAE = (
        pair: Pair,
        rawVol0: string | number,
        rawVol1: string | number,
      ): BigNumber => {
        const isToken0 = pair.token0.address === tokenAddress;
        const otherTokenAddress = isToken0
          ? pair.token1.address
          : pair.token0.address;
        const isBothAex9 = !isWae(tokenAddress) && !isWae(otherTokenAddress);
        const dec0 = Number(pair.token0?.decimals ?? 18);
        const dec1 = Number(pair.token1?.decimals ?? 18);

        if (isBothAex9) {
          if (!currentPrice) return new BigNumber(0);
          const raw = isToken0 ? rawVol0 : rawVol1;
          const dec = isToken0 ? dec0 : dec1;
          return humanAmount(raw, dec).multipliedBy(currentPrice);
        }
        // WAE pair: take whichever leg is the WAE side, in human units.
        if (isWae(pair.token0.address)) {
          return humanAmount(rawVol0, dec0);
        }
        if (isWae(pair.token1.address)) {
          return humanAmount(rawVol1, dec1);
        }
        return new BigNumber(0);
      };

      let totalVolumeAE = new BigNumber(0);
      const periodVolumeAEByKey: Record<string, BigNumber> = {
        '24h': new BigNumber(0),
        '7d': new BigNumber(0),
        '30d': new BigNumber(0),
      };
      for (const pair of pairs) {
        const raw = rawByPair.get(pair.address);
        if (!raw) continue;
        totalVolumeAE = totalVolumeAE.plus(
          convertPairVolumeAE(pair, raw.vol0_total, raw.vol1_total),
        );
        periodVolumeAEByKey['24h'] = periodVolumeAEByKey['24h'].plus(
          convertPairVolumeAE(pair, raw.vol0_24h, raw.vol1_24h),
        );
        periodVolumeAEByKey['7d'] = periodVolumeAEByKey['7d'].plus(
          convertPairVolumeAE(pair, raw.vol0_7d, raw.vol1_7d),
        );
        periodVolumeAEByKey['30d'] = periodVolumeAEByKey['30d'].plus(
          convertPairVolumeAE(pair, raw.vol0_30d, raw.vol1_30d),
        );
      }

      const totalVolumePriceData =
        await this.aePricingService.getPriceData(totalVolumeAE);

      const change: any = {};

      for (const [periodKey, startDate] of Object.entries(periods)) {
        const periodVolumePriceData = await this.aePricingService.getPriceData(
          periodVolumeAEByKey[periodKey],
        );

        let startPrice: string | null = null;
        if (isWae(tokenAddress)) {
          // WAE is wrapped AE: its AE price is constant 1, so there is no price
          // change. Without this, currentPrice (1) would be compared against the
          // WAE/other-token start ratio (e.g. 0.003) and report a huge bogus %.
          startPrice = '1';
        }
        // Prefer WAE pairs for historical start price. NOTE: this used
        // `process.env.DEX_WAE`, which is never set (WAE comes from network
        // config), so the filter always matched nothing and silently fell back
        // to an arbitrary pair. Use the configured WAE address.
        const waePairs = pairs.filter((p) =>
          p.token0.address === tokenAddress
            ? isWae(p.token1.address)
            : isWae(p.token0.address),
        );
        const candidatePairs = waePairs.length ? waePairs : pairs;
        for (const pair of candidatePairs) {
          // WAE already has its flat start price (1); skip the ratio lookup.
          if (startPrice) break;
          const isToken0 = pair.token0.address === tokenAddress;
          const other = isToken0 ? '1' : '0';
          const row = await queryRunner.query(
            `
              SELECT ratio${other} AS start_ratio
              FROM pair_transactions
              WHERE pair_address = $1 AND created_at >= $2
              ORDER BY created_at ASC LIMIT 1
            `,
            [pair.address, startDate.toDate()],
          );
          const sr = row?.[0]?.start_ratio;
          if (sr && sr !== 'NaN') {
            // `ratio${other}` is RAW (next-token-per-current-token). Normalise it
            // to a human price — × 10^(decToken - decOther) — so it is on the
            // same scale as `currentPrice` (human AE). Comparing the raw ratio
            // to the human price made the % change garbage for any non-18-dp
            // token. For the preferred WAE pair this yields the token's AE price.
            const tokenDec = Number(
              (isToken0 ? pair.token0 : pair.token1)?.decimals ?? 18,
            );
            const otherDec = Number(
              (isToken0 ? pair.token1 : pair.token0)?.decimals ?? 18,
            );
            const scale = priceScaleOf(tokenDec, otherDec);
            const candidate = new BigNumber(String(sr)).multipliedBy(scale);
            // Skip dust-state start ratios (a near-empty pool yields an absurd
            // value); try the next candidate pair instead of reporting a
            // multi-million-percent change.
            if (isSanePrice(candidate)) {
              startPrice = candidate.toString();
              break;
            }
          }
        }

        let percentage = '0.00';
        if (currentPrice && startPrice) {
          const sp = new BigNumber(startPrice);
          const cp = new BigNumber(currentPrice);
          if (!sp.isZero()) {
            percentage = cp
              .minus(sp)
              .dividedBy(sp)
              .multipliedBy(100)
              .toString();
          }
        }

        change[periodKey] = {
          volume: periodVolumePriceData,
          percentage,
        };
      }

      const existing = await this.dexTokenSummaryRepository.findOne({
        where: { token_address: tokenAddress },
      });

      if (existing) {
        existing.total_volume = totalVolumePriceData;
        existing.change = change;
        return this.dexTokenSummaryRepository.save(existing);
      } else {
        const created = this.dexTokenSummaryRepository.create({
          token_address: tokenAddress,
          total_volume: totalVolumePriceData,
          change,
        });
        return this.dexTokenSummaryRepository.save(created);
      }
    } finally {
      await queryRunner.release();
    }
  }
}
