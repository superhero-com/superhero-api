import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Pagination, paginate } from 'nestjs-typeorm-paginate';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { Repository } from 'typeorm';
import { TokenHolderDto } from './dto/token-holder.dto';
import { TokenDto } from './dto/token.dto';
import { TokenHolder } from './entities/token-holders.entity';
import { Token } from './entities/token.entity';
import { ApiOkResponsePaginated } from '../utils/api-type';
import { TokensService } from './tokens.service';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { Queue } from 'bull';
import { SYNC_TOKEN_HOLDERS_QUEUE } from './queues/constants';

@Controller('tokens')
@UseInterceptors(CacheInterceptor)
@ApiTags('Tokens')
export class TokensController {
  constructor(
    @InjectRepository(Token)
    private readonly tokensRepository: Repository<Token>,

    @InjectRepository(TokenHolder)
    private readonly tokenHolderRepository: Repository<TokenHolder>,

    @InjectQueue(SYNC_TOKEN_HOLDERS_QUEUE)
    private readonly syncTokenHoldersQueue: Queue,

    private readonly tokensService: TokensService,
    private readonly communityFactoryService: CommunityFactoryService,
  ) {
    //
  }

  @ApiQuery({ name: 'search', type: 'string', required: false })
  @ApiQuery({ name: 'factory_address', type: 'string', required: false })
  @ApiQuery({ name: 'creator_address', type: 'string', required: false })
  @ApiQuery({ name: 'owner_address', type: 'string', required: false })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['name', 'price', 'market_cap', 'created_at', 'holders_count'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOperation({ operationId: 'listTokenHolders' })
  @ApiOkResponsePaginated(TokenHolderDto)
  @CacheTTL(10)
  @Get(':address/holders')
  async listTokenHolders(
    @Param('address') address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ): Promise<Pagination<TokenHolder>> {
    const token = await this.tokensService.findByAddress(address);
    const queryBuilder =
      this.tokenHolderRepository.createQueryBuilder('token_holder');

    queryBuilder.orderBy(`token_holder.balance`, 'DESC');
    queryBuilder.where('token_holder.aex9_address = :aex9_address', {
      aex9_address: token.address,
    });

    // check if count is 0
    const count = await queryBuilder.getCount();
    if (count <= 1) {
      void this.syncTokenHoldersQueue.add(
        {
          saleAddress: token.sale_address,
        },
        {
          jobId: `syncTokenHolders-${token.sale_address}`,
          removeOnComplete: true,
        },
      );
    }

    return paginate<TokenHolder>(queryBuilder, { page, limit });
  }

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOperation({ operationId: 'listTokenRankings' })
  @ApiOkResponsePaginated(TokenDto)
  @CacheTTL(10)
  @Get(':address/rankings')
  async listTokenRankings(
    @Param('address') address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit = 5,
  ): Promise<Pagination<Token>> {
    const token = await this.tokensService.findByAddress(address);
    if (!token) {
      return {
        items: [],
        meta: {
          currentPage: page,
          itemCount: 0,
          itemsPerPage: limit,
          totalItems: 0,
          totalPages: 0,
        },
      };
    }

    const factory = await this.communityFactoryService.getCurrentFactory();

    // Get tokens with market cap around the target token
    const rankedQuery = `
      WITH ranked_tokens AS (
        SELECT 
          t.*,
          CAST(RANK() OVER (
            ORDER BY 
              CASE WHEN t.market_cap = 0 THEN 1 ELSE 0 END,
              t.market_cap DESC,
              t.created_at ASC
          ) AS INTEGER) as rank
        FROM token t
        WHERE t.factory_address = '${factory.address}'
      ),
      target_rank AS (
        SELECT rank
        FROM ranked_tokens
        WHERE sale_address = '${token.sale_address}'
      ),
      adjusted_limits AS (
        SELECT 
          CASE 
            WHEN (SELECT rank FROM target_rank) <= 2
            THEN ${Math.floor(limit / 2)} - (SELECT rank FROM target_rank) + 1
            ELSE ${Math.floor(limit / 2)} 
          END as upper_limit,
          ${Math.floor(limit / 2)} as lower_limit
      )
      SELECT 
        ranked_tokens.*,
        row_to_json(token_performance_view.*) as performance
      FROM ranked_tokens
      LEFT JOIN token_performance_view ON ranked_tokens.sale_address = token_performance_view.sale_address
      WHERE rank >= (
        SELECT rank FROM target_rank
      ) - (SELECT lower_limit FROM adjusted_limits)
      AND rank <= (
        SELECT rank FROM target_rank
      ) + (SELECT upper_limit FROM adjusted_limits)
      ORDER BY market_cap DESC
    `;

    const rankedTokens = await this.tokensRepository.query(rankedQuery);

    return {
      items: rankedTokens,
      meta: {
        currentPage: page,
        itemCount: rankedTokens.length,
        itemsPerPage: limit,
        totalItems: rankedTokens.length,
        totalPages: 1,
      },
    };
  }

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @ApiOperation({ operationId: 'getTokenScore' })
  @CacheTTL(1)
  @Get(':address/score')
  async getTokenScore(@Param('address') address: string): Promise<any> {
    const token = await this.tokensService.findByAddress(address);

    return this.tokensService.updateTokenTrendingScore(token);
  }
}
