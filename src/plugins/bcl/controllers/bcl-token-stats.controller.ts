import {
  Controller,
  DefaultValuePipe,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  Post,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { BclTokenStatsService } from '../services/bcl-token-stats.service';
import { BclTokenStatsRefreshService } from '../services/bcl-token-stats-refresh.service';
import { BclTokenStatsDto } from '../dto/bcl-token-stats.dto';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { Pagination } from 'nestjs-typeorm-paginate';

@Controller('bcl/token-stats')
@ApiTags('BCL')
export class BclTokenStatsController {
  constructor(
    private readonly tokenStatsService: BclTokenStatsService,
    private readonly refreshService: BclTokenStatsRefreshService,
  ) {}

  @ApiOperation({
    operationId: 'findAllTokenStats',
    summary: 'Get all BCL token stats',
    description:
      'Retrieve a paginated list of BCL token stats, ordered by trending score descending',
  })
  @ApiQuery({
    name: 'page',
    type: 'number',
    required: false,
    description: 'Page number',
  })
  @ApiQuery({
    name: 'limit',
    type: 'number',
    required: false,
    description: 'Items per page',
  })
  @ApiOkResponsePaginated(BclTokenStatsDto)
  @Get()
  async findAllTokenStats(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ): Promise<Pagination<BclTokenStatsDto> & { queryMs: number }> {
    return this.tokenStatsService.findAll({ page, limit });
  }

  @ApiOperation({
    operationId: 'getTopTokens',
    summary: 'Get top tokens by trending score',
    description: 'Retrieve top N tokens by trending score',
  })
  @ApiParam({
    name: 'limit',
    type: 'number',
    required: false,
    description: 'Number of top tokens to return (default: 10)',
  })
  @ApiResponse({
    type: [BclTokenStatsDto],
    status: HttpStatus.OK,
  })
  @Get('top/:limit')
  async getTopTokens(
    @Param('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number = 10,
  ): Promise<BclTokenStatsDto[]> {
    return this.tokenStatsService.getTopTokens(limit);
  }

  @ApiOperation({
    operationId: 'getTokenStatsBySaleAddress',
    summary: 'Get token stats for a specific token',
    description: 'Retrieve token stats metrics for a token by sale address',
  })
  @ApiParam({
    name: 'saleAddress',
    type: 'string',
    description: 'Token sale address',
  })
  @ApiResponse({
    type: BclTokenStatsDto,
    status: HttpStatus.OK,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Token stats not found',
  })
  @Get(':saleAddress')
  async getTokenStatsBySaleAddress(
    @Param('saleAddress') saleAddress: string,
  ): Promise<BclTokenStatsDto> {
    const stats = await this.tokenStatsService.findBySaleAddress(
      saleAddress,
    );
    if (!stats) {
      throw new NotFoundException(
        `Token stats for sale address ${saleAddress} not found`,
      );
    }
    return stats;
  }

  @ApiOperation({
    operationId: 'refreshTokenStats',
    summary: 'Manually refresh token stats materialized view',
    description:
      'Trigger a manual refresh of the bcl_token_stats materialized view',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Refresh initiated successfully',
  })
  @Post('refresh')
  async refreshTokenStats(): Promise<{
    message: string;
    isRefreshing: boolean;
  }> {
    const isRefreshing = this.refreshService.isCurrentlyRefreshing();
    if (isRefreshing) {
      return {
        message: 'Refresh already in progress',
        isRefreshing: true,
      };
    }

    // Trigger refresh asynchronously
    this.refreshService.manualRefresh().catch((error) => {
      // Error is already logged in the service
    });

    return {
      message: 'Refresh initiated',
      isRefreshing: false,
    };
  }
}

