import { TokensService } from '@/tokens/tokens.service';
import { TokenPriceMovementDto } from '@/transactions/dto/token-stats.dto';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import moment from 'moment';
import { Repository } from 'typeorm';
import { Token } from '../entities/token.entity';
import { TokenPerformanceView } from '../entities/tokens-performance.view';
import { TokenPerformanceService } from '../services/token-performance.service';

@Controller('tokens')
@UseInterceptors(CacheInterceptor)
@ApiTags('Tokens')
export class TokenPerformanceController {
  constructor(
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    private readonly tokensService: TokensService,
    private readonly tokenPerformanceService: TokenPerformanceService,
  ) {
    //
  }

  @ApiOperation({ operationId: 'performance' })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @Get(':address/performance')
  @CacheTTL(60 * 1000)
  @ApiResponse({
    type: TokenPriceMovementDto,
  })
  async performance(@Param('address') address: string) {
    const token = await this.tokensService.getToken(address);

    if (!token) {
      throw new NotFoundException('Token not found');
    }

    // Check if we have recent cached performance data
    const cachedPerformance =
      await this.tokenPerformanceService.getPerformanceData(token.sale_address);

    if (cachedPerformance) {
      // Check if data is recent (within 1 hour)
      const isRecent =
        await this.tokenPerformanceService.isPerformanceDataRecent(
          token.sale_address,
          1,
        );

      if (isRecent) {
        // Return cached data
        const performanceData =
          this.tokenPerformanceService.convertToPerformanceDto(
            cachedPerformance,
          );

        return {
          token_id: token.sale_address,
          past_24h: performanceData.past_24h,
          past_7d: performanceData.past_7d,
          past_30d: performanceData.past_30d,
          all_time: performanceData.all_time,
        };
      }
    }

    // Calculate fresh performance data
    const past_24h = await this.tokenPerformanceService.getTokenPriceMovement(
      token,
      moment().subtract(24, 'hours'),
    );

    const past_7d = await this.tokenPerformanceService.getTokenPriceMovement(
      token,
      moment().subtract(7, 'days'),
    );

    const past_30d = await this.tokenPerformanceService.getTokenPriceMovement(
      token,
      moment().subtract(30, 'days'),
    );

    const all_time = await this.tokenPerformanceService.getTokenPriceMovement(
      token,
      moment(token.created_at).subtract(30, 'days'),
    );

    // Add last_updated field to performance data
    const performanceDataWithTimestamp = {
      past_24h: { ...past_24h, last_updated: new Date() },
      past_7d: { ...past_7d, last_updated: new Date() },
      past_30d: { ...past_30d, last_updated: new Date() },
      all_time: { ...all_time, last_updated: new Date() },
    };

    // Store the calculated performance data
    await this.tokenPerformanceService.storePerformanceData(
      token,
      performanceDataWithTimestamp,
    );

    return {
      token_id: token.sale_address,
      past_24h: performanceDataWithTimestamp.past_24h,
      past_7d: performanceDataWithTimestamp.past_7d,
      past_30d: performanceDataWithTimestamp.past_30d,
      all_time: performanceDataWithTimestamp.all_time,
    };
  }

  @ApiOperation({
    operationId: 'performanceRaw',
    summary: 'Get token performance without cache (using database view)',
    description:
      'Calculates performance data in real-time using database view. Useful for analysis and comparison with cached data.',
  })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @Get(':address/performance-raw')
  @CacheTTL(60 * 1000)
  @ApiResponse({
    type: TokenPriceMovementDto,
  })
  async performanceRaw(@Param('address') address: string) {
    const token = await this.tokensService.getToken(address);

    if (!token) {
      throw new NotFoundException('Token not found');
    }

    // Query the view directly for this token
    const viewData = await this.tokenRepository
      .createQueryBuilder('token')
      .leftJoinAndMapOne(
        'token.performance_view',
        TokenPerformanceView,
        'perf',
        'perf.sale_address = token.sale_address',
      )
      .where('token.sale_address = :saleAddress', {
        saleAddress: token.sale_address,
      })
      .getOne();

    return viewData;
  }
}
