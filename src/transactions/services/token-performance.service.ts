import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TokenPerformance } from '../entities/token-performance.entity';
import { Token } from '@/tokens/entities/token.entity';
import { PriceMovementDto } from '../dto/token-stats.dto';
import { PriceDto } from '@/tokens/dto/price.dto';

@Injectable()
export class TokenPerformanceService {
  constructor(
    @InjectRepository(TokenPerformance)
    private readonly tokenPerformanceRepository: Repository<TokenPerformance>,
  ) {}

  /**
   * Store all performance data for a token in a single record
   */
  async storePerformanceData(
    token: Token,
    performanceData: {
      past_24h: PriceMovementDto;
      past_7d: PriceMovementDto;
      past_30d: PriceMovementDto;
      all_time: PriceMovementDto;
    },
  ): Promise<TokenPerformance> {
    // Check if performance data already exists for this token
    const existing = await this.tokenPerformanceRepository.findOne({
      where: { sale_address: token.sale_address },
    });

    const performanceDataToStore = {
      sale_address: token.sale_address,
      past_24h_data: performanceData.past_24h as any,
      past_7d_data: performanceData.past_7d as any,
      past_30d_data: performanceData.past_30d as any,
      all_time_data: performanceData.all_time as any,
    };

    if (existing) {
      // Update existing record
      await this.tokenPerformanceRepository.update(
        token.sale_address,
        performanceDataToStore,
      );
      return this.tokenPerformanceRepository.findOne({
        where: { sale_address: token.sale_address },
      });
    } else {
      // Create new record
      const newPerformance = this.tokenPerformanceRepository.create(
        performanceDataToStore,
      );
      return this.tokenPerformanceRepository.save(newPerformance);
    }
  }

  /**
   * Retrieve performance data for a token
   */
  async getPerformanceData(
    tokenSaleAddress: string,
  ): Promise<TokenPerformance | null> {
    return this.tokenPerformanceRepository.findOne({
      where: { sale_address: tokenSaleAddress },
    });
  }

  /**
   * Retrieve performance data for multiple tokens
   */
  async getPerformanceDataForTokens(
    tokenSaleAddresses: string[],
  ): Promise<TokenPerformance[]> {
    if (tokenSaleAddresses.length === 1) {
      const result = await this.tokenPerformanceRepository.findOne({
        where: { sale_address: tokenSaleAddresses[0] },
      });
      return result ? [result] : [];
    }

    return this.tokenPerformanceRepository
      .createQueryBuilder('performance')
      .where('performance.sale_address IN (:...addresses)', {
        addresses: tokenSaleAddresses,
      })
      .orderBy('performance.sale_address', 'ASC')
      .getMany();
  }

  /**
   * Convert stored performance data to DTO format
   */
  convertToPerformanceDto(performance: TokenPerformance): {
    past_24h: PriceMovementDto;
    past_7d: PriceMovementDto;
    past_30d: PriceMovementDto;
    all_time: PriceMovementDto;
  } {
    return {
      past_24h: this.convertToPriceMovementDto(performance.past_24h_data),
      past_7d: this.convertToPriceMovementDto(performance.past_7d_data),
      past_30d: this.convertToPriceMovementDto(performance.past_30d_data),
      all_time: this.convertToPriceMovementDto(performance.all_time_data),
    };
  }

  /**
   * Convert IPriceDto to PriceDto
   */
  private convertToPriceDto(priceData: any): PriceDto {
    return {
      ae: priceData?.ae || 0,
      usd: priceData?.usd || 0,
      eur: priceData?.eur || 0,
      aud: priceData?.aud || 0,
      brl: priceData?.brl || 0,
      cad: priceData?.cad || 0,
      chf: priceData?.chf || 0,
      gbp: priceData?.gbp || 0,
      xau: priceData?.xau || 0,
    };
  }

  /**
   * Convert stored performance data to PriceMovementDto format
   */
  private convertToPriceMovementDto(performanceData: any): PriceMovementDto {
    if (!performanceData) {
      return null;
    }

    return {
      current: this.convertToPriceDto(performanceData.current),
      current_date: performanceData.current_date,
      current_change: performanceData.current_change,
      current_change_percent: performanceData.current_change_percent,
      current_change_direction: performanceData.current_change_direction,
      high: this.convertToPriceDto(performanceData.high),
      high_date: performanceData.high_date,
      high_change: performanceData.high_change,
      high_change_percent: performanceData.high_change_percent,
      high_change_direction: performanceData.high_change_direction,
      low: this.convertToPriceDto(performanceData.low),
      low_date: performanceData.low_date,
      low_change: performanceData.low_change,
      low_change_percent: performanceData.low_change_percent,
      low_change_direction: performanceData.low_change_direction,
      last_updated: performanceData.last_updated,
    };
  }

  /**
   * Delete old performance data (for cleanup)
   */
  async deleteOldPerformanceData(olderThanDays: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const result = await this.tokenPerformanceRepository
      .createQueryBuilder()
      .delete()
      .where('created_at < :cutoffDate', { cutoffDate })
      .execute();

    return result.affected || 0;
  }

  /**
   * Check if performance data exists and is recent (within specified hours)
   */
  async isPerformanceDataRecent(
    tokenSaleAddress: string,
    maxAgeHours: number = 1,
  ): Promise<boolean> {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - maxAgeHours);

    const performance = await this.tokenPerformanceRepository.findOne({
      where: { sale_address: tokenSaleAddress },
    });

    return performance && performance.updated_at > cutoffTime;
  }

  /**
   * Get all performance data for a token
   */
  async getAllPerformanceData(
    tokenSaleAddress: string,
  ): Promise<TokenPerformance | null> {
    return this.getPerformanceData(tokenSaleAddress);
  }
}