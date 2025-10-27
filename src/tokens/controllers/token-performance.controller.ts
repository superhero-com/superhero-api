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
import { Repository } from 'typeorm';
import { TokenPerformanceView } from '../entities/tokens-performance.view';

@Controller('tokens')
@UseInterceptors(CacheInterceptor)
@ApiTags('Tokens')
export class TokenPerformanceController {
  constructor(
    @InjectRepository(TokenPerformanceView)
    private readonly tokenPerformanceViewRepository: Repository<TokenPerformanceView>,
    private readonly tokensService: TokensService,
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

    // Query the view directly for this token
    const performanceData = await this.tokenPerformanceViewRepository.findOne({
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
    description:
      'Returns performance data using database view. This endpoint is kept for backward compatibility.',
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
