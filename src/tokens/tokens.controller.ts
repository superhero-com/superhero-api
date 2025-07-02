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
import BigNumber from 'bignumber.js';
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
    enum: ['name', 'price', 'market_cap', 'created_at'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiQuery({
    name: 'collection',
    enum: ['all', 'word', 'number'],
    required: false,
  })
  @ApiOperation({ operationId: 'listAll' })
  @ApiOkResponsePaginated(TokenDto)
  @CacheTTL(10)
  @Get()
  async listAll(
    @Query('search') search = undefined,
    @Query('factory_address') factory_address = undefined,
    @Query('creator_address') creator_address = undefined,
    @Query('owner_address') owner_address = undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'market_cap',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
    @Query('collection') collection: 'all' | 'word' | 'number' = 'all',
  ): Promise<Pagination<Token>> {
    // Now, wrap with RANK()
    // allowed sort fields to avoid SQL Injection
    const allowedSortFields = [
      'market_cap',
      'rank',
      'name',
      'price',
      'created_at',
      'trending_score',
    ];
    if (!allowedSortFields.includes(orderBy)) {
      orderBy = 'market_cap';
    }
    const allowedOrderDirections = ['ASC', 'DESC'];
    if (!allowedOrderDirections.includes(orderDirection)) {
      orderDirection = 'DESC';
    }

    const queryBuilder = this.tokensRepository
      .createQueryBuilder('token')
      .select('token.*')
      .where('token.unlisted = false');

    if (search) {
      queryBuilder.andWhere('token.name ILIKE :search', {
        search: `%${search}%`,
      });
    }
    if (factory_address) {
      queryBuilder.andWhere('token.factory_address = :factory_address', {
        factory_address,
      });
    }
    // else {
    //   const factory = await this.communityFactoryService.getCurrentFactory();
    //   queryBuilder.andWhere('token.factory_address = :address', {
    //     address: factory.address,
    //   });
    // }
    if (collection !== 'all') {
      queryBuilder.andWhere('token.collection = :collection', { collection });
    }
    if (creator_address) {
      queryBuilder.andWhere('token.creator_address = :creator_address', {
        creator_address,
      });
    }

    if (owner_address) {
      const ownedTokens = await this.tokenHolderRepository
        .createQueryBuilder('token_holder')
        .where('token_holder.address = :owner_address', { owner_address })
        .andWhere('token_holder.balance > 0')
        .select('token_holder."aex9_address"')
        .distinct(true)
        .getRawMany()
        .then((res) => res.map((r) => r.aex9_address));

      // queryBuilder.andWhereInIds(ownedTokens);

      queryBuilder.andWhere('token.address IN (:...aex9_addresses)', {
        aex9_addresses: ownedTokens,
      });
    }

    return this.tokensService.queryTokensWithRanks(
      queryBuilder,
      limit,
      page,
      orderBy,
      orderDirection,
    );
  }

  @ApiOperation({ operationId: 'findByAddress' })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @Get(':address')
  @CacheTTL(3)
  @ApiResponse({
    type: TokenDto,
  })
  async findByAddress(@Param('address') address: string) {
    const token = await this.tokensService.getToken(address);

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
      SELECT *
      FROM ranked_tokens
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

  @ApiQuery({ name: 'price', type: 'number', required: true })
  @ApiQuery({ name: 'token_address', type: 'string', required: false })
  @ApiQuery({ name: 'factory_address', type: 'string', required: false })
  @ApiQuery({ name: 'supply', type: 'string', required: false })
  @ApiOperation({ operationId: 'estimatePrice', deprecated: true })
  @ApiOkResponsePaginated(TokenDto)
  @Get('contracts/estimate-price')
  async estimatePrice(
    @Query('token_address') token_address = undefined,
    @Query('factory_address') factory_address = undefined,
    @Query('price') price = 1,
    @Query('supply') supply = 0,
  ): Promise<any> {
    let totalSupply = supply;
    let factoryAddress = factory_address;
    if (token_address) {
      const token = await this.tokensService.findByAddress(token_address);
      totalSupply = token.total_supply.toNumber();
      factoryAddress = token.factory_address;
    }

    const calculators = {
      default: (targetValue, supply) => {
        // Define the integral function from supply to supply + x
        function integralFunction(x) {
          return (
            Math.exp(0.00000000002 * (supply + x)) / 0.00000000002 -
            Math.exp(0.00000000002 * supply) / 0.00000000002 -
            1 * x -
            targetValue
          );
        }

        // Set an initial guess dynamically based on the target
        const initialGuess = Math.max(1000000, targetValue * 1000);

        // Define the tolerance and the maximum number of iterations
        const tolerance = 1e-5;
        const maxIterations = 10000;

        // Define the bisection method
        let low = 0; // Set a lower bound
        let high = initialGuess; // Set an upper bound
        let x = (low + high) / 2; // Midpoint between low and high
        let iteration = 0;
        let error = Math.abs(integralFunction(x));

        // Perform bisection method
        while (error > tolerance && iteration < maxIterations) {
          // Check if the function changes signs
          if (integralFunction(low) * integralFunction(x) < 0) {
            high = x; // If sign changes, move the high bound
            x = (low + high) / 2; // New midpoint
          } else {
            low = x; // If no sign change, move the low bound
            x = low + high / 4; // New midpoint
          }
          error = Math.abs(integralFunction(x)); // Update error
          iteration++;
        }

        // Check if the solver succeeded
        if (iteration >= maxIterations) {
          throw new Error(
            'Solver did not converge within the max number of iterations.',
          );
        }

        return x;
      },
    };

    let findXForTarget = calculators.default;

    if (Object.keys(calculators).includes(factoryAddress)) {
      findXForTarget = calculators[factoryAddress];
    }

    const x = findXForTarget(
      price,
      new BigNumber(totalSupply).shiftedBy(-18).toNumber(),
    );

    return {
      price,
      x,
    };
  }
}
