import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { LeaderboardService } from '../services/leaderboard.service';
import {
  LeaderboardItem,
  LeaderboardSortBy,
  LeaderboardSortDir,
  LeaderboardWindow,
} from '../services/leaderboard.types';
import { GetLeaderboardQueryDto } from '../dto/get-leaderboard-query.dto';

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
    timeFilter?: {
      start: string;
      end: string;
    };
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
      'Returns paginated trading leaders with metrics (AUM, PNL, ROI, MDD), activity counters, and a portfolio sparkline. ' +
      'Without startDate + endDate, metrics are precomputed per window (7d / 30d / all). ' +
      'When startDate + endDate are supplied, leaders are ranked by selected-period performance among accounts that traded within that time range. ' +
      'In that mode, top-level metrics and buy/sell counts are scoped to the requested time range. ' +
      'Note: responses are cached for up to 60 seconds, so `meta.timeFilter.start` and `meta.timeFilter.end` reflect the time the cache entry was filled, not strictly the time of the current request.',
  })
  @ApiOkResponse({ type: LeaderboardResponseDto })
  @CacheTTL(60_000)
  @Get()
  async getLeaderboard(
    @Query() query: GetLeaderboardQueryDto,
  ): Promise<LeaderboardResponseDto> {
    const result = await this.leaderboardService.getLeaders(query);
    const totalPages =
      result.totalCandidates === 0
        ? 0
        : Math.ceil(result.totalCandidates / result.limit);

    return {
      items: result.items,
      meta: {
        page: result.page,
        limit: result.limit,
        totalItems: result.totalCandidates,
        totalPages,
        window: result.window,
        sortBy: result.sortBy,
        sortDir: result.sortDir,
        timeFilter: result.timeFilter
          ? {
              start: result.timeFilter.start.toISOString(),
              end: result.timeFilter.end.toISOString(),
            }
          : undefined,
      },
    };
  }
}
