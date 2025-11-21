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
  ApiTags,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Pagination } from 'nestjs-typeorm-paginate';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { BclTokensService } from '../services/bcl-tokens.service';
import { BclTokenView } from '../entities/bcl-token.view';
import { BclTokenDto } from '../dto/bcl-token.dto';
import { CommunityFactoryService } from '@/ae/community-factory.service';

@Controller('bcl/tokens')
@UseInterceptors(CacheInterceptor)
@ApiTags('BCL')
export class BclTokenRankingsController {
  constructor(
    @InjectRepository(BclTokenView)
    private readonly bclTokenViewRepository: Repository<BclTokenView>,
    private readonly bclTokensService: BclTokensService,
    private readonly communityFactoryService: CommunityFactoryService,
    private readonly dataSource: DataSource,
  ) {}

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address, sale address, name, or symbol',
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOperation({ 
    operationId: 'getTokenRankings',
    summary: 'Get token rankings around a specific token',
    description: 'Returns tokens ranked around the specified token based on market cap',
  })
  @ApiOkResponsePaginated(BclTokenDto)
  @CacheTTL(10)
  @Get(':address/rankings')
  async listTokenRankings(
    @Param('address') address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit = 5,
  ): Promise<Pagination<BclTokenDto>> {
    const token = await this.bclTokensService.findByAddress(address);
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
    // Using bcl_tokens_view which already has rank and performance calculated
    const rankedQuery = `
      WITH target_token AS (
        SELECT rank, sale_address
        FROM bcl_tokens_view
        WHERE sale_address = $1
          AND factory_address = $2
      ),
      adjusted_limits AS (
        SELECT 
          CASE 
            WHEN (SELECT rank FROM target_token) <= 2
            THEN $3 - (SELECT rank FROM target_token) + 1
            ELSE $3 
          END as upper_limit,
          $3 as lower_limit
      )
      SELECT 
        bt.*
      FROM bcl_tokens_view bt
      WHERE bt.factory_address = $2
        AND bt.unlisted = false
        AND bt.rank >= (
          SELECT rank FROM target_token
        ) - (SELECT lower_limit FROM adjusted_limits)
        AND bt.rank <= (
          SELECT rank FROM target_token
        ) + (SELECT upper_limit FROM adjusted_limits)
      ORDER BY bt.rank ASC
      LIMIT $4
    `;

    const lowerLimit = Math.floor(limit / 2);
    const rankedTokens = await this.dataSource.query(rankedQuery, [
      token.sale_address,
      factory.address,
      lowerLimit,
      limit,
    ]);

    // Map query results to DTOs
    // The query already returns all fields from bcl_tokens_view with performance joined
    const items: BclTokenDto[] = rankedTokens.map((row: any) => {
      const buyPrice = row.buy_price || null;
      const sellPrice = row.sell_price || null;
      const marketCap = row.market_cap || null;
      
      return {
        sale_address: row.sale_address,
        unlisted: row.unlisted,
        last_tx_hash: row.last_tx_hash || '',
        last_sync_block_height: row.last_sync_block_height || 0,
        last_sync_tx_count: 0,
        tx_count: row.tx_count,
        holders_count: 0,
        factory_address: row.factory_address,
        create_tx_hash: row.create_tx_hash,
        dao_address: row.dao_address,
        creator_address: row.creator_address,
        beneficiary_address: row.beneficiary_address,
        bonding_curve_address: row.bonding_curve_address,
        dao_balance: row.dao_balance?.ae?.toString() || '0',
        owner_address: row.owner_address,
        address: row.address,
        name: row.name,
        symbol: row.symbol,
        decimals: row.decimals?.toString() || '18',
        collection: row.collection,
        price: buyPrice?.ae ? buyPrice.ae.toString() : '0',
        price_data: buyPrice || {},
        sell_price: sellPrice?.ae ? sellPrice.ae.toString() : '0',
        sell_price_data: sellPrice || {},
        market_cap: marketCap?.ae ? marketCap.ae.toString() : '0',
        market_cap_data: marketCap || {},
        total_supply: row.total_supply || '0',
        trending_score: row.trending_score?.toString() || '0',
        trending_score_update_at: row.trending_score_update_at,
        created_at: row.created_at,
        rank: row.rank,
        performance: row.performance || null,
      };
    });

    const validItems = items;

    return {
      items: validItems,
      meta: {
        currentPage: page,
        itemCount: validItems.length,
        itemsPerPage: limit,
        totalItems: validItems.length,
        totalPages: 1,
      },
    };
  }
}

