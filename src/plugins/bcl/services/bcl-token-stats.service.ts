import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BclTokenStats } from '../entities/bcl-token-stats.view';
import { BclTokenStatsDto } from '../dto/bcl-token-stats.dto';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';

@Injectable()
export class BclTokenStatsService {
  private readonly logger = new Logger(BclTokenStatsService.name);

  constructor(
    @InjectRepository(BclTokenStats)
    private readonly tokenStatsRepository: Repository<BclTokenStats>,
  ) {}

  /**
   * Get all token stats with pagination
   */
  async findAll(
    options: IPaginationOptions,
  ): Promise<Pagination<BclTokenStatsDto> & { queryMs: number }> {
    const queryBuilder = this.tokenStatsRepository
      .createQueryBuilder('token_stats')
      .orderBy('token_stats.trending_score', 'DESC')
      .addOrderBy('token_stats.lifetime_minutes', 'ASC');

    const startTime = Date.now();
    const paginationResult = await paginate<BclTokenStats>(
      queryBuilder,
      options,
    );
    const queryMs = Date.now() - startTime;

    const items = paginationResult.items.map((item) =>
      this.toDto(item),
    );

    return {
      ...paginationResult,
      items,
      queryMs,
    };
  }

  /**
   * Get token stats for a specific token by sale address
   */
  async findBySaleAddress(
    saleAddress: string,
  ): Promise<BclTokenStatsDto | null> {
    try {
      const stats = await this.tokenStatsRepository.findOne({
        where: { sale_address: saleAddress },
      });

      if (!stats) {
        this.logger.debug(
          `Token stats not found for sale address: ${saleAddress}`,
        );
        return null;
      }

      return this.toDto(stats);
    } catch (error: any) {
      this.logger.error(
        `Error finding token stats for sale address ${saleAddress}:`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get top N tokens by trending score
   */
  async getTopTokens(
    limit: number = 10,
  ): Promise<BclTokenStatsDto[]> {
    try {
      const stats = await this.tokenStatsRepository.find({
        order: {
          trending_score: 'DESC',
          lifetime_minutes: 'ASC',
        },
        take: limit,
      });

      return stats.map((stat) => this.toDto(stat));
    } catch (error: any) {
      this.logger.error('Error getting top tokens:', error.stack);
      throw error;
    }
  }

  /**
   * Convert entity to DTO
   */
  private toDto(stats: BclTokenStats): BclTokenStatsDto {
    return {
      sale_address: stats.sale_address,
      unique_transactions: stats.unique_transactions,
      investment_volume: stats.investment_volume,
      lifetime_minutes: stats.lifetime_minutes,
      min_unique_transactions: stats.min_unique_transactions,
      max_unique_transactions: stats.max_unique_transactions,
      min_investment_volume: stats.min_investment_volume,
      max_investment_volume: stats.max_investment_volume,
      tx_normalization: stats.tx_normalization,
      volume_normalization: stats.volume_normalization,
      trending_score: stats.trending_score,
      calculated_at: stats.calculated_at,
    };
  }
}

