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
    if (tokenAddress === DEX_CONTRACTS.wae) {
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
      .then((analysis) => analysis?.medianPrice ?? null)
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
      // Total volume across all pairs involving the token, converted to AE
      let totalVolumeAE = new BigNumber(0);
      const currentPrice = await this.getMedianTokenPrice(
        tokenAddress,
        summaryOptions,
      );

      for (const pair of pairs) {
        const isToken0 = pair.token0.address === tokenAddress;
        const pos = isToken0 ? '0' : '1';

        // Check if both tokens are AEX-9 tokens (not WAE)
        const otherTokenAddress = isToken0
          ? pair.token1.address
          : pair.token0.address;
        const isBothAex9 =
          tokenAddress !== DEX_CONTRACTS.wae &&
          otherTokenAddress !== DEX_CONTRACTS.wae;

        let volumeResult;

        if (isBothAex9) {
          if (currentPrice) {
            // Join with pairs and tokens to get decimals for proper volume conversion
            // Convert volumes from raw units to human-readable before multiplying by token price
            volumeResult = await queryRunner.query(
              `
                SELECT 
                  COALESCE(SUM(
                    CASE 
                      WHEN $2 = '0' THEN (pt.volume0 / POW(10, token0.decimals)) * $3
                      WHEN $2 = '1' THEN (pt.volume1 / POW(10, token1.decimals)) * $3
                      ELSE 0
                    END
                  ), 0) as total_volume
                FROM pair_transactions pt
                INNER JOIN pairs p ON pt.pair_address = p.address
                INNER JOIN dex_tokens token0 ON p.token0_address = token0.address
                INNER JOIN dex_tokens token1 ON p.token1_address = token1.address
                WHERE pt.pair_address = $1 
                  AND pt.tx_type IN (
                    'swap_exact_tokens_for_tokens',
                    'swap_tokens_for_exact_tokens', 
                    'swap_exact_tokens_for_ae',
                    'swap_tokens_for_exact_ae',
                    'swap_exact_ae_for_tokens',
                    'swap_ae_for_exact_tokens'
                  )
              `,
              [pair.address, pos, currentPrice],
            );
          } else {
            // If we can't find a price, skip this pair
            continue;
          }
        } else {
          // Original logic for pairs with WAE
          // Join with pairs and tokens to get decimals for proper volume conversion
          // Need to check which token is WAE to convert correctly
          volumeResult = await queryRunner.query(
            `
              SELECT 
                COALESCE(SUM(
                  CASE 
                    WHEN $2 = '0' AND token0.address = $3 THEN pt.volume0 / POW(10, token0.decimals)
                    WHEN $2 = '0' AND token1.address = $3 THEN 
                      (pt.volume0 / POW(10, token0.decimals)) * 
                      ((pt.reserve1 / POW(10, token1.decimals)) / (pt.reserve0 / POW(10, token0.decimals)))
                    WHEN $2 = '1' AND token0.address = $3 THEN 
                      (pt.volume1 / POW(10, token1.decimals)) * 
                      ((pt.reserve0 / POW(10, token0.decimals)) / (pt.reserve1 / POW(10, token1.decimals)))
                    WHEN $2 = '1' AND token1.address = $3 THEN pt.volume1 / POW(10, token1.decimals)
                    ELSE 0
                  END
                ), 0) as total_volume
              FROM pair_transactions pt
              INNER JOIN pairs p ON pt.pair_address = p.address
              INNER JOIN dex_tokens token0 ON p.token0_address = token0.address
              INNER JOIN dex_tokens token1 ON p.token1_address = token1.address
              WHERE pt.pair_address = $1 
                AND pt.tx_type IN (
                  'swap_exact_tokens_for_tokens',
                  'swap_tokens_for_exact_tokens', 
                  'swap_exact_tokens_for_ae',
                  'swap_tokens_for_exact_ae',
                  'swap_exact_ae_for_tokens',
                  'swap_ae_for_exact_tokens'
                )
            `,
            [pair.address, pos, DEX_CONTRACTS.wae],
          );
        }

        totalVolumeAE = totalVolumeAE.plus(
          new BigNumber(volumeResult[0]?.total_volume || 0),
        );
      }

      const totalVolumePriceData =
        await this.aePricingService.getPriceData(totalVolumeAE);

      const now = moment();
      const periods: Record<string, moment.Moment> = {
        '24h': now.clone().subtract(24, 'hours'),
        '7d': now.clone().subtract(7, 'days'),
        '30d': now.clone().subtract(30, 'days'),
      };

      const change: any = {};

      for (const [periodKey, startDate] of Object.entries(periods)) {
        // Period volume across all pairs
        let periodVolumeAE = new BigNumber(0);
        for (const pair of pairs) {
          const isToken0 = pair.token0.address === tokenAddress;
          const pos = isToken0 ? '0' : '1';

          // Check if both tokens are AEX-9 tokens (not WAE)
          const otherTokenAddress = isToken0
            ? pair.token1.address
            : pair.token0.address;
          const isBothAex9 =
            tokenAddress !== DEX_CONTRACTS.wae &&
            otherTokenAddress !== DEX_CONTRACTS.wae;

          let periodVolumeResult;

          if (isBothAex9) {
            if (currentPrice) {
              // Join with pairs and tokens to get decimals for proper volume conversion
              // Convert volumes from raw units to human-readable before multiplying by token price
              periodVolumeResult = await queryRunner.query(
                `
                  SELECT 
                    COALESCE(SUM(
                      CASE 
                        WHEN $3 = '0' THEN (pt.volume0 / POW(10, token0.decimals)) * $4
                        WHEN $3 = '1' THEN (pt.volume1 / POW(10, token1.decimals)) * $4
                        ELSE 0
                      END
                    ), 0) as total_volume
                  FROM pair_transactions pt
                  INNER JOIN pairs p ON pt.pair_address = p.address
                  INNER JOIN dex_tokens token0 ON p.token0_address = token0.address
                  INNER JOIN dex_tokens token1 ON p.token1_address = token1.address
                  WHERE pt.pair_address = $1 
                    AND pt.created_at >= $2
                    AND pt.tx_type IN (
                      'swap_exact_tokens_for_tokens',
                      'swap_tokens_for_exact_tokens', 
                      'swap_exact_tokens_for_ae',
                      'swap_tokens_for_exact_ae',
                      'swap_exact_ae_for_tokens',
                      'swap_ae_for_exact_tokens'
                    )
                `,
                [pair.address, startDate.toDate(), pos, currentPrice],
              );
            } else {
              // If we can't find a price, skip this pair
              continue;
            }
          } else {
            // Original logic for pairs with WAE
            // Join with pairs and tokens to get decimals for proper volume conversion
            // Need to check which token is WAE to convert correctly
            periodVolumeResult = await queryRunner.query(
              `
                SELECT 
                  COALESCE(SUM(
                    CASE 
                      WHEN $3 = '0' AND token0.address = $4 THEN pt.volume0 / POW(10, token0.decimals)
                      WHEN $3 = '0' AND token1.address = $4 THEN 
                        (pt.volume0 / POW(10, token0.decimals)) * 
                        ((pt.reserve1 / POW(10, token1.decimals)) / (pt.reserve0 / POW(10, token0.decimals)))
                      WHEN $3 = '1' AND token0.address = $4 THEN 
                        (pt.volume1 / POW(10, token1.decimals)) * 
                        ((pt.reserve0 / POW(10, token0.decimals)) / (pt.reserve1 / POW(10, token1.decimals)))
                      WHEN $3 = '1' AND token1.address = $4 THEN pt.volume1 / POW(10, token1.decimals)
                      ELSE 0
                    END
                  ), 0) as total_volume
                FROM pair_transactions pt
                INNER JOIN pairs p ON pt.pair_address = p.address
                INNER JOIN dex_tokens token0 ON p.token0_address = token0.address
                INNER JOIN dex_tokens token1 ON p.token1_address = token1.address
                WHERE pt.pair_address = $1 
                  AND pt.created_at >= $2
                  AND pt.tx_type IN (
                    'swap_exact_tokens_for_tokens',
                    'swap_tokens_for_exact_tokens', 
                    'swap_exact_tokens_for_ae',
                    'swap_tokens_for_exact_ae',
                    'swap_exact_ae_for_tokens',
                    'swap_ae_for_exact_tokens'
                  )
              `,
              [pair.address, startDate.toDate(), pos, DEX_CONTRACTS.wae],
            );
          }

          periodVolumeAE = periodVolumeAE.plus(
            new BigNumber(periodVolumeResult[0]?.total_volume || 0),
          );
        }

        const periodVolumePriceData =
          await this.aePricingService.getPriceData(periodVolumeAE);

        let startPrice: string | null = null;
        // Prefer WAE pairs for historical start price
        const waePairs = pairs.filter((p) =>
          p.token0.address === tokenAddress
            ? p.token1.address === (process.env.DEX_WAE || '')
            : p.token0.address === (process.env.DEX_WAE || ''),
        );
        const candidatePairs = waePairs.length ? waePairs : pairs;
        for (const pair of candidatePairs) {
          const isToken0 = pair.token0.address === tokenAddress;
          const other = isToken0 ? '1' : '0';
          const row = await queryRunner.query(
            `
              SELECT 
                (SELECT ratio${other} FROM pair_transactions 
                 WHERE pair_address = $1 AND created_at >= $2 
                 ORDER BY created_at ASC LIMIT 1) as start_ratio,
                (SELECT ratio${other} FROM pair_transactions 
                 WHERE pair_address = $1 
                 ORDER BY created_at DESC LIMIT 1) as current_ratio
            `,
            [pair.address, startDate.toDate()],
          );
          const sr = row?.[0]?.start_ratio;
          if (sr && sr !== 'NaN') {
            startPrice = String(sr);
            break;
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
