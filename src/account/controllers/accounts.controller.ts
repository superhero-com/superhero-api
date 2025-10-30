import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { Account } from '../entities/account.entity';
import { PortfolioService } from '../services/portfolio.service';
import moment from 'moment';

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
  @ApiQuery({ name: 'startDate', type: 'string', required: false, description: 'Start date (ISO 8601)' })
  @ApiQuery({ name: 'endDate', type: 'string', required: false, description: 'End date (ISO 8601)' })
  @ApiQuery({ name: 'interval', type: 'number', required: false, description: 'Interval in seconds (default: 86400 for daily)' })
  @ApiQuery({
    name: 'convertTo',
    enum: ['ae', 'usd', 'eur', 'aud', 'brl', 'cad', 'chf', 'gbp', 'xau'],
    required: false,
    description: 'Currency to convert to (default: ae)',
  })
  @Get(':address/portfolio/history')
  async getPortfolioHistory(
    @Param('address') address: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('interval', new DefaultValuePipe(86400), ParseIntPipe) interval?: number,
    @Query('convertTo') convertTo?: 'ae' | 'usd' | 'eur' | 'aud' | 'brl' | 'cad' | 'chf' | 'gbp' | 'xau',
  ) {
    const start = startDate ? moment(startDate) : undefined;
    const end = endDate ? moment(endDate) : undefined;

    return await this.portfolioService.getPortfolioHistory(address, {
      startDate: start,
      endDate: end,
      interval,
      convertTo: convertTo || 'ae',
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
