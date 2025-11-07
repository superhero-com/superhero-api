import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import {
  Controller,
  DefaultValuePipe,
  Get,
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
import { GetPortfolioHistoryQueryDto } from '../dto/get-portfolio-history-query.dto';
import { PortfolioHistorySnapshotDto } from '../dto/portfolio-history-response.dto';

@UseInterceptors(CacheInterceptor)
@Controller('accounts')
@ApiTags('Accounts')
export class AccountsController {
  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    private readonly portfolioService: PortfolioService,
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

    return await this.portfolioService.getPortfolioHistory(address, {
      startDate: start,
      endDate: end,
      interval: query.interval || 86400,
      convertTo: query.convertTo || 'ae',
      includePnl: includeFields.includes('pnl'),
    });
  }

  // single account - MUST come after more specific routes
  @ApiOperation({ operationId: 'getAccount' })
  @ApiParam({ name: 'address', type: 'string' })
  @Get(':address')
  async getAccount(@Param('address') address: string) {
    const account = await this.accountRepository.findOne({
      where: { address },
    });

    if (!account) {
      throw new NotFoundException('Account not found');
    }

    return account;
  }
}
