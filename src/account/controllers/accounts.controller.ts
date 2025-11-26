import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import {
  Controller,
  DefaultValuePipe,
  Get,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import moment from 'moment';
import { paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { Account } from '../entities/account.entity';
import { PortfolioService } from '../services/portfolio.service';
import { AccountService } from '../services/account.service';
import { GetPortfolioHistoryQueryDto } from '../dto/get-portfolio-history-query.dto';
import { PortfolioHistorySnapshotDto } from '../dto/portfolio-history-response.dto';

@UseInterceptors(CacheInterceptor)
@Controller('accounts')
@ApiTags('Accounts')
export class AccountsController {
  private readonly logger = new Logger(AccountsController.name);

  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    private readonly portfolioService: PortfolioService,
    private readonly accountService: AccountService,
  ) {
    //
  }

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
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
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'total_volume',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
  ) {
    const query = this.accountRepository.createQueryBuilder('account');
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
  private getMinimumInterval(start?: moment.Moment, end?: moment.Moment): number {
    if (!start || !end) {
      // If no dates provided, default to daily interval
      return 86400;
    }

    const periodDays = end.diff(start, 'days');
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
  @ApiOperation({ operationId: 'getPortfolioHistory' })
  @ApiParam({ name: 'address', type: 'string', description: 'Account address' })
  @ApiOkResponse({ type: [PortfolioHistorySnapshotDto] })
  @CacheTTL(60 * 10) // 10 minutes
  @Get(':address/portfolio/history')
  async getPortfolioHistory(
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

    const includePnl = includeFields.includes('pnl') || includeFields.includes('pnl-range');
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

    // Fetch chain name from middleware if not stored or stale (older than 24 hours)
    // This ensures we always return the current chain name
    const CHAIN_NAME_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
    const now = new Date();
    const isStale = account.chain_name_updated_at 
      ? (now.getTime() - account.chain_name_updated_at.getTime()) > CHAIN_NAME_STALE_THRESHOLD_MS
      : true; // If never updated, consider it stale
    
    let chainName = account.chain_name;
    if (!chainName || isStale) {
      chainName = await this.accountService.getChainNameForAccount(address);
      // Update the database (but don't block the response)
      const updateData: Partial<Account> = {
        chain_name: chainName,
        chain_name_updated_at: now,
      };
      this.accountRepository.update(address, updateData).catch((err) => {
        // Log but don't throw - this is a background update
        this.logger.warn(`Failed to update chain_name for ${address}`, err);
      });
    }

    return {
      ...account,
      chain_name: chainName,
    };
  }
}
