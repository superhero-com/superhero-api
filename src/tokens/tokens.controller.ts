import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Inject,
  NotFoundException,
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
import { Repository, SelectQueryBuilder } from 'typeorm';
import { TokenHolderDto } from './dto/token-holder.dto';
import { TokenDto } from './dto/token.dto';
import { TokenHolder } from './entities/token-holders.entity';
import { Token } from './entities/token.entity';
import { ApiOkResponsePaginated } from '../utils/api-type';
import { TokensService } from './tokens.service';
import {
  CACHE_MANAGER,
  CacheInterceptor,
  CacheTTL,
} from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Queue } from 'bull';
import { SYNC_TOKEN_HOLDERS_QUEUE } from './queues/constants';
import {
  OptionalAeAccountAddressPipe,
  OptionalAeContractAddressPipe,
} from '@/common/validation/request-validation';

const TOKENS_LIST_CACHE_TTL_MS = 60 * 1000;
const TRENDING_TOKENS_LIST_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_TOKEN_SEARCH_LENGTH = 100;
const MAX_PAGE_LIMIT = 100;

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
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {
    //
  }

  /**
   * Attaches the resolved `collection_info` badge object to each token, mapping
   * the stored `collection` id through the factory's collection registry. The
   * factory schema is loaded once for the whole batch. Tokens with no/unknown
   * collection get `collection_info: null`.
   */
  private async attachCollectionInfo(
    items: Array<{ collection?: string | null }>,
  ): Promise<void> {
    if (!items?.length) {
      return;
    }
    const factory = await this.communityFactoryService.getCurrentFactory();
    for (const item of items) {
      (item as any).collection_info =
        this.communityFactoryService.mapCollectionInfo(
          factory,
          item?.collection,
        );
    }
  }

  private validatePagination(page: number, limit: number): void {
    if (page < 1) {
      throw new BadRequestException('Page must be greater than or equal to 1');
    }
    if (limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw new BadRequestException(
        `Limit must be between 1 and ${MAX_PAGE_LIMIT}`,
      );
    }
  }

  private buildTrendingListCacheKey(params: {
    search?: string;
    factory_address?: string;
    creator_address?: string;
    owner_address?: string;
    page: number;
    limit: number;
    orderBy: string;
    orderDirection: 'ASC' | 'DESC';
    collection: string;
  }): string {
    return `tokens:list:trending:${JSON.stringify({
      orderBy: params.orderBy,
      orderDirection: params.orderDirection,
      page: params.page,
      limit: params.limit,
      collection: params.collection,
      search: params.search || '',
      factory_address: params.factory_address || '',
      creator_address: params.creator_address || '',
      owner_address: params.owner_address || '',
    })}`;
  }

  @ApiQuery({ name: 'search', type: 'string', required: false })
  @ApiQuery({ name: 'factory_address', type: 'string', required: false })
  @ApiQuery({ name: 'creator_address', type: 'string', required: false })
  @ApiQuery({ name: 'owner_address', type: 'string', required: false })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: [
      'name',
      'price',
      'market_cap',
      'created_at',
      'holders_count',
      'rank',
      'treasury',
      'trending_score',
    ],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiQuery({
    name: 'collection',
    type: 'string',
    required: false,
    description:
      "Filter by collection. 'all' (default) returns every collection; otherwise pass a collection name (e.g. 'WORDS', 'CHINESE') or a full collection id (e.g. 'CHINESE-ak_...').",
  })
  @ApiOperation({ operationId: 'listAll' })
  @ApiOkResponsePaginated(TokenDto)
  @CacheTTL(TOKENS_LIST_CACHE_TTL_MS)
  @Get()
  async listAll(
    @Query('search') search = undefined,
    @Query('factory_address', OptionalAeContractAddressPipe)
    factory_address = undefined,
    @Query('creator_address', OptionalAeAccountAddressPipe)
    creator_address = undefined,
    @Query('owner_address', OptionalAeAccountAddressPipe)
    owner_address = undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'market_cap',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
    @Query('collection') collection: string = 'all',
  ): Promise<Pagination<Token>> {
    this.validatePagination(page, limit);
    // Now, wrap with RANK()
    // allowed sort fields to avoid SQL Injection
    const allowedSortFields = [
      'market_cap',
      'rank',
      'name',
      'price',
      'created_at',
      'treasury',
      'trending_score',
      'holders_count',
    ];
    if (!allowedSortFields.includes(orderBy)) {
      orderBy = 'market_cap';
    }
    const allowedOrderDirections = ['ASC', 'DESC'];
    if (!allowedOrderDirections.includes(orderDirection)) {
      orderDirection = 'DESC';
    }
    if (search && search.length > MAX_TOKEN_SEARCH_LENGTH) {
      throw new BadRequestException(
        `search must be at most ${MAX_TOKEN_SEARCH_LENGTH} characters`,
      );
    }

    let trendingCacheKey: string | null = null;
    if (orderBy === 'trending_score') {
      trendingCacheKey = this.buildTrendingListCacheKey({
        search,
        factory_address,
        creator_address,
        owner_address,
        page,
        limit,
        orderBy,
        orderDirection,
        collection,
      });
      const cached =
        await this.cacheManager.get<Pagination<Token>>(trendingCacheKey);
      if (cached) {
        // Enrich on read as well: entries cached before collection_info existed
        // (or with stale collection metadata) must still carry the field on the
        // hit path, which otherwise returns before attachCollectionInfo runs.
        await this.attachCollectionInfo(cached.items);
        return cached;
      }
    }

    // Common filters (everything except the trending eligibility gate). Kept as
    // a factory so the query can be rebuilt without the gate for the fallback.
    const buildBaseQuery = (): SelectQueryBuilder<Token> => {
      const qb = this.tokensRepository
        .createQueryBuilder('token')
        .select('token.*')
        .where('token.unlisted = false');

      if (search) {
        qb.andWhere('token.name ILIKE :search', { search: `%${search}%` });
      }
      if (factory_address) {
        qb.andWhere('token.factory_address = :factory_address', {
          factory_address,
        });
      }
      if (collection && collection.toLowerCase() !== 'all') {
        if (collection.includes('-ak_')) {
          // Full collection id, e.g. "CHINESE-ak_3A4g...".
          qb.andWhere('token.collection = :collectionId', {
            collectionId: collection,
          });
        } else {
          // Collection name, e.g. "CHINESE" — match the name part of the stored
          // "<NAME>-ak_<deployer>" id, case-insensitively.
          qb.andWhere(
            `LOWER(split_part(token.collection, '-ak_', 1)) = LOWER(:collectionName)`,
            { collectionName: collection },
          );
        }
      }
      if (creator_address) {
        qb.andWhere('token.creator_address = :creator_address', {
          creator_address,
        });
      }
      if (owner_address) {
        qb.andWhere(
          `EXISTS (
            SELECT 1
            FROM token_holder
            WHERE token_holder.aex9_address = token.address
              AND token_holder.address = :owner_address
              AND token_holder.balance > 0
          )`,
          { owner_address },
        );
      }
      return qb;
    };

    const queryBuilder = buildBaseQuery();
    if (orderBy === 'trending_score') {
      this.tokensService.applyListEligibilityFilters(queryBuilder);
    }

    let result = await this.tokensService.queryTokensWithRanks(
      queryBuilder,
      limit,
      page,
      orderBy,
      orderDirection,
    );

    // Fallback: if NO token clears the trending eligibility gate, drop the gate
    // and return tokens anyway — an empty trending tab is worse than showing
    // tokens that just have no activity yet. Keyed on the total (not this page)
    // so pagination stays consistent across pages, not just page 1.
    if (orderBy === 'trending_score' && result.meta.totalItems === 0) {
      result = await this.tokensService.queryTokensWithRanks(
        buildBaseQuery(),
        limit,
        page,
        orderBy,
        orderDirection,
      );
    }

    await this.attachCollectionInfo(result.items);

    if (trendingCacheKey) {
      await this.cacheManager.set(
        trendingCacheKey,
        result,
        TRENDING_TOKENS_LIST_CACHE_TTL_MS,
      );
    }

    return result;
  }

  @ApiOperation({ operationId: 'getTrendingEligibility' })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @Get(':address/trending-eligibility')
  @CacheTTL(3_000)
  async getTrendingEligibility(@Param('address') address: string) {
    return this.tokensService.getTrendingEligibilityBreakdown(address);
  }

  @ApiOperation({ operationId: 'findByAddress' })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @Get(':address')
  @CacheTTL(3_000)
  @ApiResponse({
    type: TokenDto,
  })
  async findByAddress(@Param('address') address: string) {
    const token = await this.tokensService.getToken(address);

    if (token) {
      await this.attachCollectionInfo([token as any]);
    }

    return token;
  }

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOperation({ operationId: 'listTokenHolders' })
  @ApiOkResponsePaginated(TokenHolderDto)
  @CacheTTL(10_000)
  @Get(':address/holders')
  async listTokenHolders(
    @Param('address') address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ): Promise<Pagination<TokenHolder>> {
    this.validatePagination(page, limit);
    const token = await this.tokensService.findByAddress(address);
    if (!token) {
      throw new NotFoundException('Token not found');
    }

    const queryBuilder =
      this.tokenHolderRepository.createQueryBuilder('token_holder');

    queryBuilder.orderBy(`token_holder.balance`, 'DESC');
    queryBuilder.where('token_holder.aex9_address = :aex9_address', {
      aex9_address: token.address,
    });
    queryBuilder.andWhere('token_holder.balance > 0');

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
          removeOnFail: true,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 3_000,
          },
          timeout: Number(
            process.env.SYNC_TOKEN_HOLDERS_JOB_TIMEOUT_MS || 180_000,
          ),
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
  @CacheTTL(10_000)
  @Get(':address/rankings')
  async listTokenRankings(
    @Param('address') address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit = 5,
  ): Promise<Pagination<Token>> {
    this.validatePagination(page, limit);
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

    // All values below are bound as parameters rather than interpolated
    // into the SQL string. Even though `factory.address` and
    // `token.sale_address` come from our own DB today, string
    // interpolation here would mean a single compromised upstream row
    // becomes SQL injection. `Math.floor(limit / 2)` is numeric and still
    // bound as a parameter for consistency.
    const halfLimit = Math.floor(limit / 2);
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
        WHERE t.factory_address = $1
      ),
      target_rank AS (
        SELECT rank
        FROM ranked_tokens
        WHERE sale_address = $2
      ),
      adjusted_limits AS (
        SELECT
          CASE
            WHEN (SELECT rank FROM target_rank) <= 2
            THEN $3::int - (SELECT rank FROM target_rank) + 1
            ELSE $3::int
          END as upper_limit,
          $3::int as lower_limit
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

    const rankedTokens = await this.tokensRepository.query(rankedQuery, [
      factory.address,
      token.sale_address,
      halfLimit,
    ]);

    for (const rankedToken of rankedTokens) {
      rankedToken.collection_info =
        this.communityFactoryService.mapCollectionInfo(
          factory,
          rankedToken?.collection,
        );
    }

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
  @CacheTTL(1_000)
  @Get(':address/score')
  async getTokenScore(@Param('address') address: string): Promise<any> {
    const token = await this.tokensService.findByAddress(address);
    if (!token) {
      throw new NotFoundException('Token not found');
    }

    return this.tokensService.updateTokenTrendingScore(token);
  }
}
