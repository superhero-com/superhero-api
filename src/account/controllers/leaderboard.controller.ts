import {
  Controller,
  Get,
  Query,
  UseInterceptors,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import {
  GetLeadersParams,
  LeaderboardItem,
  LeaderboardService,
  LeaderboardSortBy,
  LeaderboardSortDir,
  LeaderboardWindow,
} from '../services/leaderboard.service';

class LeaderboardResponseDto {
  items!: LeaderboardItem[];
  meta!: {
    page: number;
    limit: number;
    totalItems: number;
    totalPages: number;
    window: LeaderboardWindow;
    sortBy: LeaderboardSortBy;
    sortDir: LeaderboardSortDir;
  };
}

@UseInterceptors(CacheInterceptor)
@Controller('accounts/leaderboard')
@ApiTags('Accounts')
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  @ApiOperation({
    operationId: 'getAccountsLeaderboard',
    description:
      'Returns paginated trading leaders with metrics (AUM, PNL, ROI, MDD), activity counters, and portfolio sparkline.',
  })
  @ApiOkResponse({ type: LeaderboardResponseDto })
  @ApiQuery({
    name: 'window',
    required: false,
    enum: ['7d', '30d', 'all'],
    example: '7d',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['pnl', 'roi', 'mdd', 'aum'],
    example: 'pnl',
  })
  @ApiQuery({
    name: 'sortDir',
    required: false,
    enum: ['ASC', 'DESC'],
    example: 'DESC',
  })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 18 })
  @ApiQuery({
    name: 'points',
    required: false,
    example: 30,
    description: 'Approximate number of sparkline points',
  })
  @ApiQuery({
    name: 'minAumUsd',
    required: false,
    example: 1,
    description: 'Exclude leaders with AUM below this USD value',
  })
  @ApiQuery({
    name: 'maxCandidates',
    required: false,
    example: 36,
    description: 'Upper bound of candidate addresses to evaluate',
  })
  @CacheTTL(60) // cache 1 minute
  @Get()
  async getLeaderboard(
    @Query('window') window: LeaderboardWindow = '7d',
    @Query('sortBy') sortBy: LeaderboardSortBy = 'pnl',
    @Query('sortDir')
    sortDir: LeaderboardSortDir = (sortBy === 'mdd'
      ? 'ASC'
      : 'DESC') as LeaderboardSortDir,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(18), ParseIntPipe) limit = 18,
    @Query('points', new DefaultValuePipe(30), ParseIntPipe) points = 30,
    @Query('minAumUsd', new DefaultValuePipe(1), ParseIntPipe) minAumUsd = 1,
    @Query('maxCandidates', new DefaultValuePipe(36), ParseIntPipe)
    maxCandidates = 36,
  ): Promise<LeaderboardResponseDto> {
    const params: GetLeadersParams = {
      window,
      sortBy,
      sortDir,
      page,
      limit,
      points,
      minAumUsd,
      maxCandidates,
    };
    const result = await this.leaderboardService.getLeaders(params);
    return {
      items: result.items,
      meta: {
        page: result.page,
        limit: result.limit,
        totalItems: result.totalCandidates,
        totalPages: Math.max(
          1,
          Math.ceil(result.totalCandidates / result.limit),
        ),
        window,
        sortBy,
        sortDir,
      },
    };
  }
}
