import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import {
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import moment from 'moment';
import { paginate } from 'nestjs-typeorm-paginate';
import { Brackets, Repository } from 'typeorm';
import { Account } from '../entities/account.entity';
import { PortfolioService } from '../services/portfolio.service';
import { BclPnlService } from '../services/bcl-pnl.service';
import { AccountService } from '../services/account.service';
import { GetPortfolioHistoryQueryDto } from '../dto/get-portfolio-history-query.dto';
import { PortfolioHistorySnapshotDto } from '../dto/portfolio-history-response.dto';
import { TradingStatsQueryDto } from '../dto/trading-stats-query.dto';
import { TradingStatsResponseDto } from '../dto/trading-stats-response.dto';
import { ProfileReadService } from '@/profile/services/profile-read.service';
import { ProfileCache } from '@/profile/entities/profile-cache.entity';
import { buildSparklineSvg, sparklineStroke } from '@/utils/sparkline.util';

@UseInterceptors(CacheInterceptor)
@Controller('accounts')
@ApiTags('Accounts')
export class AccountsController {
  private readonly logger = new Logger(AccountsController.name);

  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    private readonly portfolioService: PortfolioService,
    private readonly bclPnlService: BclPnlService,
    private readonly accountService: AccountService,
    private readonly profileReadService: ProfileReadService,
  ) {
    //
  }

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'search',
    type: 'string',
    required: false,
    description: 'Search accounts by address or name',
  })
  @ApiQuery({
    name: 'order_by',
    enum: [
      'total_volume',
      'total_tx_count',
      'total_buy_tx_count',
      'total_sell_tx_count',
      'total_created_tokens',
      'total_invitation_count',
      'total_claimed_invitation_count',
      'total_revoked_invitation_count',
      'created_at',
    ],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({ operationId: 'listAll' })
  @Get()
  async listAll(
    @Query('search') search: string | undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'total_volume',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
  ) {
    const query = this.accountRepository.createQueryBuilder('account');

    if (search?.trim()) {
      const normalizedSearch = `%${search.trim()}%`;
      query.leftJoin(
        ProfileCache,
        'profile_cache',
        'profile_cache.address = account.address',
      );
      query.andWhere(
        new Brackets((qb) => {
          qb.where('account.address ILIKE :search', {
            search: normalizedSearch,
          })
            .orWhere('account.chain_name ILIKE :search', {
              search: normalizedSearch,
            })
            .orWhere('profile_cache.public_name ILIKE :search', {
              search: normalizedSearch,
            })
            .orWhere('profile_cache.chain_name ILIKE :search', {
              search: normalizedSearch,
            })
            .orWhere('profile_cache.username ILIKE :search', {
              search: normalizedSearch,
            })
            .orWhere('profile_cache.fullname ILIKE :search', {
              search: normalizedSearch,
            });
        }),
      );
    }

    if (orderBy) {
      query.orderBy(`account.${orderBy}`, orderDirection);
    }
    return paginate(query, { page, limit });
  }

  /**
   * Calculate minimum allowed interval based on the period between start and end dates
   * @param start Start date moment object
   * @param end End date moment object
   * @returns Minimum interval in seconds
   */
  private getMinimumInterval(
    start?: moment.Moment,
    end?: moment.Moment,
  ): number {
    if (!start || !end) {
      // If no dates provided, default to daily interval
      return 86400;
    }

    const periodMonths = end.diff(start, 'months', true);

    // If period is in days or weeks (less than 1 month), hourly interval is okay
    if (periodMonths < 1) {
      return 3600; // 1 hour
    }

    // If period is 1-3 months, minimum 4 hour interval
    if (periodMonths >= 1 && periodMonths < 3) {
      return 14400; // 4 hours
    }

    // If period is 3-6 months, minimum 1 day interval
    if (periodMonths >= 3 && periodMonths < 6) {
      return 86400; // 1 day
    }

    // If period is 6+ months, minimum 1 week interval
    return 604800; // 1 week
  }

  // Portfolio history endpoint - MUST come before :address route to avoid route conflict
  @ApiOperation({
    operationId: 'getPortfolioHistory',
    summary: 'Portfolio value history snapshots',
    description:
      'Returns portfolio value over time (AE balance, token values, total value). ' +
      'Pass include=pnl or include=pnl-range to add aggregate total_pnl data. ' +
      'Per-token PnL breakdown (tokens_pnl) is available via the dedicated :address/portfolio/tokens/history endpoint.',
  })
  @ApiParam({ name: 'address', type: 'string', description: 'Account address' })
  @ApiOkResponse({ type: [PortfolioHistorySnapshotDto] })
  @CacheTTL(60 * 10) // 10 minutes
  @Get(':address/portfolio/history')
  async getPortfolioHistory(
    //
    @Param('address') address: string,
    @Query() query: GetPortfolioHistoryQueryDto,
  ) {
    const start = query.startDate ? moment(query.startDate) : undefined;
    const end = query.endDate ? moment(query.endDate) : undefined;
    const includeFields = query.include
      ? query.include.split(',').map((f) => f.trim())
      : [];

    // Calculate minimum allowed interval based on period
    const minimumInterval = this.getMinimumInterval(start, end);
    const requestedInterval = query.interval || 86400;

    // Use the larger of requested interval or minimum allowed interval
    const finalInterval = Math.max(requestedInterval, minimumInterval);

    const includePnl =
      includeFields.includes('pnl') || includeFields.includes('pnl-range');
    const useRangeBasedPnl = includeFields.includes('pnl-range');

    return await this.portfolioService.getPortfolioHistory(address, {
      startDate: start,
      endDate: end,
      interval: finalInterval,
      convertTo: query.convertTo || 'ae',
      includePnl,
      useRangeBasedPnl,
    });
  }

  @ApiOperation({
    operationId: 'getTokensPnlHistory',
    summary: 'Per-token PnL history snapshots',
    description:
      'Returns portfolio history snapshots that include the per-token PnL breakdown (tokens_pnl). ' +
      'PnL data is always included; pass include=pnl-range to use range-based (daily window) PnL instead of cumulative.',
  })
  @ApiParam({ name: 'address', type: 'string', description: 'Account address' })
  @ApiOkResponse({ type: [PortfolioHistorySnapshotDto] })
  @CacheTTL(60 * 10)
  @Get(':address/portfolio/tokens/history')
  async getTokensPnlHistory(
    @Param('address') address: string,
    @Query() query: GetPortfolioHistoryQueryDto,
  ) {
    const start = query.startDate ? moment(query.startDate) : undefined;
    const end = query.endDate ? moment(query.endDate) : undefined;
    const includeFields = query.include
      ? query.include.split(',').map((f) => f.trim())
      : [];

    const minimumInterval = this.getMinimumInterval(start, end);
    const requestedInterval = query.interval || 86400;
    const finalInterval = Math.max(requestedInterval, minimumInterval);

    const useRangeBasedPnl = includeFields.includes('pnl-range');

    return await this.portfolioService.getPortfolioHistory(address, {
      startDate: start,
      endDate: end,
      interval: finalInterval,
      convertTo: query.convertTo || 'ae',
      includePnl: true,
      useRangeBasedPnl,
      includeTokensPnl: true,
    });
  }

  // Portfolio PnL sparkline — MUST come before :address route to avoid route conflict
  @ApiOperation({
    operationId: 'getPortfolioPnlChart',
    summary:
      'SVG sparkline of daily (or hourly for a single-day range) realized PnL',
  })
  @ApiParam({ name: 'address', type: 'string', description: 'Account address' })
  @ApiQuery({ name: 'startDate', type: 'string', required: false })
  @ApiQuery({ name: 'endDate', type: 'string', required: false })
  @ApiQuery({
    name: 'convertTo',
    enum: ['ae', 'usd'],
    required: false,
    example: 'ae',
  })
  @ApiQuery({ name: 'width', type: 'number', required: false, example: 160 })
  @ApiQuery({ name: 'height', type: 'number', required: false, example: 60 })
  @ApiQuery({
    name: 'background',
    type: 'string',
    required: false,
    example: 'none',
    description: 'CSS fill for background rect, e.g. "#1a1a2e" or "none"',
  })
  @Header('Content-Type', 'image/svg+xml')
  @Header('Content-Disposition', 'inline; filename="pnl-chart.svg"')
  @CacheTTL(60 * 10)
  @Get(':address/portfolio/pnl-chart.svg')
  async getPortfolioPnlChart(
    @Param('address') address: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('convertTo') convertTo: 'ae' | 'usd' = 'ae',
    @Query('width') width = '160',
    @Query('height') height = '60',
    @Query('background') background = 'none',
  ): Promise<StreamableFile> {
    const start = startDate ? moment(startDate) : moment().subtract(30, 'days');
    const end = endDate ? moment(endDate) : moment();

    // Use hourly points for a single-day range, daily otherwise
    const rangeHours = end.diff(start, 'hours', true);
    const interval = rangeHours <= 24 ? 3600 : 86400;

    // Use the lightweight PnL-only series instead of the full portfolio history.
    // This skips AE-node balance calls, block-height resolution, and cumulative
    // PnL queries — only calculateDailyPnlBatch (one SQL query) runs.
    // resolveAccountAddress is handled inside getPnlTimeSeries.
    const points = await this.portfolioService.getPnlTimeSeries(address, {
      startDate: start,
      endDate: end,
      interval,
    });

    const values = points.map((p) => p.gain[convertTo]);

    const svg = buildSparklineSvg(
      values,
      Number(width),
      Number(height),
      sparklineStroke(values),
      background,
    );

    return new StreamableFile(Buffer.from(svg), {
      type: 'image/svg+xml',
      disposition: 'inline; filename="pnl-chart.svg"',
    });
  }

  // Portfolio stats endpoint - MUST come before :address route to avoid route conflict
  @ApiOperation({ operationId: 'getPortfolioStats' })
  @ApiParam({ name: 'address', type: 'string', description: 'Account address' })
  @ApiOkResponse({ type: TradingStatsResponseDto })
  @CacheTTL(60 * 10) // 10 minutes
  @Get(':address/portfolio/stats')
  async getPortfolioStats(
    @Param('address') address: string,
    @Query() query: TradingStatsQueryDto,
  ): Promise<TradingStatsResponseDto> {
    const start = query.startDate
      ? moment(query.startDate).toDate()
      : moment().subtract(30, 'days').toDate();
    const end = query.endDate ? moment(query.endDate).toDate() : new Date();

    const resolvedAddress =
      await this.portfolioService.resolveAccountAddress(address);

    const stats = await this.bclPnlService.calculateTradingStats(
      resolvedAddress,
      start,
      end,
    );

    return {
      top_win: stats.topWin,
      unrealized_profit: stats.unrealizedProfit,
      win_rate: stats.winRate,
      avg_duration_seconds: stats.avgDurationSeconds,
      total_trades: stats.totalTrades,
      winning_trades: stats.winningTrades,
    };
  }

  // single account - MUST come after more specific routes
  @ApiOperation({ operationId: 'getAccount' })
  @ApiParam({ name: 'address', type: 'string' })
  @CacheTTL(60 * 10) // 10 minutes cache
  @Get(':address')
  async getAccount(@Param('address') address: string) {
    const account = await this.accountRepository.findOne({
      where: { address },
    });

    if (!account) {
      throw new NotFoundException('Account not found');
    }

    // Fetch chain name from middleware if stale (older than 24 hours) or never checked
    const CHAIN_NAME_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
    const now = new Date();
    const isStale = account.chain_name_updated_at
      ? now.getTime() - account.chain_name_updated_at.getTime() >
        CHAIN_NAME_STALE_THRESHOLD_MS
      : true;

    let chainName = account.chain_name;
    let chainNameUpdatedAt = account.chain_name_updated_at;

    if (isStale) {
      const fetchedChainName =
        await this.accountService.getChainNameForAccount(address);

      if (fetchedChainName !== undefined) {
        chainName = fetchedChainName;
        chainNameUpdatedAt = now;
        const updateData: Partial<Account> = {
          chain_name: chainName,
          chain_name_updated_at: now,
        };
        this.accountRepository.update(address, updateData).catch((err) => {
          this.logger.warn(`Failed to update chain_name for ${address}`, err);
        });
      }
    }

    const profile = await this.profileReadService.getProfile(address);

    return {
      ...account,
      chain_name: chainName,
      chain_name_updated_at: chainNameUpdatedAt,
      profile: profile.profile,
      public_name: profile.public_name,
    };
  }
}
