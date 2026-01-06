import { BclTokensService } from '@/plugins/bcl/services/bcl-tokens.service';
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
import { Repository } from 'typeorm';
import { BclTokenPerformanceView } from '@/plugins/bcl/entities/bcl-token-performance.view';

@Controller('tokens')
@UseInterceptors(CacheInterceptor)
@ApiTags('Tokens')
export class TokenPerformanceController {
  constructor(
    @InjectRepository(BclTokenPerformanceView)
    private readonly bclTokenPerformanceViewRepository: Repository<BclTokenPerformanceView>,
    private readonly bclTokensService: BclTokensService,
  ) {
    //
  }

  @ApiOperation({
    operationId: 'performance',
    deprecated: true,
    description: 'This endpoint is deprecated. Use /bcl/tokens/:address/performance instead.',
  })
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
    const token = await this.bclTokensService.findByAddress(address);

    if (!token) {
      throw new NotFoundException('Token not found');
    }

    // Query the BCL performance view directly for this token
    const performanceData = await this.bclTokenPerformanceViewRepository.findOne({
      where: { sale_address: token.sale_address },
    });

    if (!performanceData) {
      throw new NotFoundException('Performance data not found for this token');
    }

    return {
      token_id: token.sale_address,
      ...performanceData,
    };
  }

  @ApiOperation({
    operationId: 'performanceRaw',
    summary: 'Get token performance (alias for /performance)',
    deprecated: true,
    description: 'This endpoint is deprecated. Use /bcl/tokens/:address/performance instead.',
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
    // Redirect to the main performance endpoint
    return this.performance(address);
  }
}

