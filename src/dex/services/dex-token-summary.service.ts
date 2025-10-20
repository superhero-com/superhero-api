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

  async createOrUpdateSummary(tokenAddress: string): Promise<DexTokenSummary> {
    const token = await this.dexTokenRepository.findOne({
      where: { address: tokenAddress },
    });
    if (!token) {
      return null;
    }

    const pairs = await this.pairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .where('token0.address = :addr OR token1.address = :addr', {
        addr: tokenAddress,
      })
      .getMany();

    const queryRunner = this.dataSource.createQueryRunner();

    try {
      // Total volume across all pairs involving the token, converted to AE
      let totalVolumeAE = new BigNumber(0);

      for (const pair of pairs) {
        const isToken0 = pair.token0.address === tokenAddress;
        const pos = isToken0 ? '0' : '1';
        const volumeResult = await queryRunner.query(
          `
            SELECT 
              COALESCE(SUM(
                CASE 
                  WHEN $2 = '0' THEN volume0 * ratio1
                  WHEN $2 = '1' THEN volume1 * ratio0
                  ELSE 0
                END
              ), 0) as total_volume
            FROM pair_transactions 
            WHERE pair_address = $1 
              AND tx_type IN (
                'swap_exact_tokens_for_tokens',
                'swap_tokens_for_exact_tokens', 
                'swap_exact_tokens_for_ae',
                'swap_tokens_for_exact_ae',
                'swap_exact_ae_for_tokens',
                'swap_ae_for_exact_tokens'
              )
          `,
          [pair.address, pos],
        );
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
          const periodVolumeResult = await queryRunner.query(
            `
              SELECT 
                COALESCE(SUM(
                  CASE 
                    WHEN $3 = '0' THEN volume0 * ratio1
                    WHEN $3 = '1' THEN volume1 * ratio0
                    ELSE 0
                  END
                ), 0) as total_volume
              FROM pair_transactions 
              WHERE pair_address = $1 
                AND created_at >= $2
                AND tx_type IN (
                  'swap_exact_tokens_for_tokens',
                  'swap_tokens_for_exact_tokens', 
                  'swap_exact_tokens_for_ae',
                  'swap_tokens_for_exact_ae',
                  'swap_exact_ae_for_tokens',
                  'swap_ae_for_exact_tokens'
                )
            `,
            [pair.address, startDate.toDate(), pos],
          );
          periodVolumeAE = periodVolumeAE.plus(
            new BigNumber(periodVolumeResult[0]?.total_volume || 0),
          );
        }

        const periodVolumePriceData =
          await this.aePricingService.getPriceData(periodVolumeAE);

        // Price change approximation: compare current routed price vs earliest price in period from any WAE pair if present
        const currentPrice = this.dexTokenService.getTokenPriceFromPairs(
          tokenAddress,
          pairs,
        )?.price;

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
