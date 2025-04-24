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
import { CommunityFactoryService } from '@/ae/community-factory.service';

@Controller('api/accounts')
@UseInterceptors(CacheInterceptor)
@ApiTags('Account Tokens')
export class AccountTokensController {
  constructor(
    @InjectRepository(TokenHolder)
    private readonly tokenHolderRepository: Repository<TokenHolder>,
    private readonly communityFactoryService: CommunityFactoryService,
  ) {
    //
  }
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Account Address',
  })
  @ApiQuery({ name: 'search', type: 'string', required: false })
  @ApiQuery({ name: 'factory_address', type: 'string', required: false })
  @ApiQuery({ name: 'creator_address', type: 'string', required: false })
  @ApiQuery({ name: 'owner_address', type: 'string', required: false })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['balance'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({ operationId: 'listTokenHolders' })
  @ApiOkResponsePaginated(TokenHolderDto)
  @CacheTTL(1000)
  @Get(':address/tokens')
  async listAccountTokens(
    @Param('address') address: string,
    @Query('search') search = undefined,
    @Query('factory_address') factory_address = undefined,
    @Query('creator_address') creator_address = undefined,
    @Query('owner_address') owner_address = undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'balance',
    @Query('order_direction') orderDirection: 'DESC' | 'DESC' = 'DESC',
  ): Promise<Pagination<TokenHolder>> {
    const queryBuilder =
      this.tokenHolderRepository.createQueryBuilder('token_holder');

    queryBuilder.orderBy(`token_holder.amount`, 'DESC');
    queryBuilder.where('token_holder.address = :address', {
      address: address,
    });
    queryBuilder.orderBy(`token_holder.${orderBy}`, orderDirection);
    queryBuilder.leftJoinAndSelect('token_holder.token', 'token');

    if (factory_address) {
      queryBuilder.andWhere('token.factory_address = :factory_address', {
        factory_address,
      });
    } else {
      const factory = await this.communityFactoryService.getCurrentFactory();
      queryBuilder.andWhere('token.factory_address = :factory_address', {
        factory_address: factory.address,
      });
    }

    if (creator_address) {
      queryBuilder.andWhere('token.creator_address = :creator_address', {
        creator_address,
      });
    } else {
      queryBuilder.andWhere('token_holder.balance > 0');
    }

    if (owner_address) {
      queryBuilder.andWhere('token.owner_address = :owner_address', {
        owner_address,
      });
    }

    if (search) {
      queryBuilder.andWhere('token.name ILIKE :search', {
        search: `%${search}%`,
      });
    }

    return paginate<TokenHolder>(queryBuilder, { page, limit });
  }
}
