import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Pagination, paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { ApiOkResponsePaginated } from '../utils/api-type';
import { TokenHolderDto } from './dto/token-holder.dto';
import { TokenHolder } from './entities/token-holders.entity';

@Controller('api/accounts')
@UseInterceptors(CacheInterceptor)
@ApiTags('Account Tokens')
export class AccountTokensController {
  constructor(
    @InjectRepository(TokenHolder)
    private readonly tokenHolderRepository: Repository<TokenHolder>,
  ) {
    //
  }
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Account Address',
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['balance', 'percentage'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({ operationId: 'listTokenHolders' })
  @ApiOkResponsePaginated(TokenHolderDto)
  @CacheTTL(1000)
  @Get(':address/tokens')
  async listAccountTokens(
    @Param('address') address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'balance',
    @Query('order_direction') orderDirection: 'DESC' | 'DESC' = 'DESC',
  ): Promise<Pagination<TokenHolder>> {
    const queryBuilder =
      this.tokenHolderRepository.createQueryBuilder('token_holder');

    queryBuilder.orderBy(`token_holder.percentage`, 'DESC');
    queryBuilder.where('token_holder.address = :address', {
      address: address,
    });
    queryBuilder.orderBy(`token_holder.${orderBy}`, orderDirection);
    queryBuilder.leftJoinAndSelect('token_holder.token', 'token');

    return paginate<TokenHolder>(queryBuilder, { page, limit });
  }
}
