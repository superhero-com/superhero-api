import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { Account } from '../entities/account.entity';

@Controller('accounts')
@ApiTags('Accounts')
export class AccountsController {
  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
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
}
