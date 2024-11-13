import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Pagination, paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { TokenHolderDto } from './dto/token-holder.dto';
import { TokenDto } from './dto/token.dto';
import { TokenHolder } from './entities/token-holders.entity';
import { Token } from './entities/token.entity';
import { ApiOkResponsePaginated } from './tmp/api-type';
import { TokensService } from './tokens.service';
import math from 'mathjs';

@Controller('api/tokens')
@ApiTags('Tokens')
export class TokensController {
  constructor(
    @InjectRepository(Token)
    private readonly tokensRepository: Repository<Token>,

    @InjectRepository(TokenHolder)
    private readonly tokenHolderRepository: Repository<TokenHolder>,

    private readonly tokensService: TokensService,
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
    enum: ['name', 'rank', 'category_rank', 'price', 'market_cap'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiQuery({
    name: 'category',
    enum: ['all', 'word', 'number'],
    required: false,
  })
  @ApiOperation({ operationId: 'listAll' })
  @ApiOkResponsePaginated(TokenDto)
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
    @Query('category') category: 'all' | 'word' | 'number' = 'all',
  ): Promise<Pagination<Token>> {
    const queryBuilder = this.tokensRepository.createQueryBuilder('token');
    // Select all columns from the 'token' table
    queryBuilder.select('token');
    queryBuilder.orderBy(`token.${orderBy}`, orderDirection);
    if (search) {
      queryBuilder.where('token.name ILIKE :search', { search: `%${search}%` });
    }
    if (factory_address) {
      queryBuilder.andWhere('token.factory_address = :factory_address', {
        factory_address,
      });
    }
    if (category !== 'all') {
      queryBuilder.andWhere('token.category = :category', {
        category,
      });
    }
    if (creator_address) {
      queryBuilder.andWhere('token.creator_address = :creator_address', {
        creator_address,
      });
    }
    if (owner_address) {
      const ownedTokens = await this.tokenHolderRepository
        .createQueryBuilder('token_holder')
        .where('token_holder.address = :owner_address', {
          owner_address,
        })
        .andWhere('token_holder.percentage > 0')
        .select('token_holder.tokenId')
        .distinct(true)
        .getRawMany()
        .then((res) => res.map((r) => r.tokenId));

      queryBuilder.andWhereInIds(ownedTokens);
    }
    return paginate<Token>(queryBuilder, {
      page,
      limit,
    });
  }

  @ApiOperation({ operationId: 'findByAddress' })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @Get(':address')
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
  @Get(':address/holders')
  async listTokenHolders(
    @Param('address') address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ): Promise<Pagination<TokenHolder>> {
    const token = await this.tokensService.findByAddress(address);
    const queryBuilder =
      this.tokenHolderRepository.createQueryBuilder('token_holder');

    queryBuilder.orderBy(`token_holder.percentage`, 'DESC');
    queryBuilder.where('token_holder.tokenId = :tokenId', {
      tokenId: token.id,
    });

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
  @Get(':address/rankings')
  async listTokenRankings(
    @Param('address') address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit = 5,
  ): Promise<Pagination<Token>> {
    const token = await this.tokensService.findByAddress(address);

    const queryBuilder = this.tokensRepository.createQueryBuilder('token');
    queryBuilder.orderBy(`token.rank`, 'ASC');

    const minRank = token.rank - Math.floor(limit / 2);
    const maxRank = token.rank + Math.floor(limit / 2);
    queryBuilder.where('token.rank BETWEEN :minRank AND :maxRank', {
      minRank,
      maxRank,
    });

    return paginate<Token>(queryBuilder, { page, limit });
  }

  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @ApiQuery({ name: 'price', type: 'string', required: true })
  @ApiOperation({ operationId: 'estimatePrice' })
  @ApiOkResponsePaginated(TokenDto)
  @Get(':address/estimate-price')
  async estimatePrice(
    @Param('address') address: string,
    @Query('price') price = 1,
  ): Promise<any> {
    const token = await this.tokensService.findByAddress(address);

    function findXForTarget(targetValue) {
      const integralFunction = (x) => {
        return (
          Math.exp(0.0000005 * x) / 0.0000005 -
          0.999999 * x -
          1 / 0.0000005 -
          targetValue
        );
      };

      const derivativeFunction = (x) => {
        return Math.exp(0.0000005 * x);
      };

      // Improved initial guess for larger target values
      let x = targetValue < 1000 ? 2000 : Math.log(targetValue) * 100000;
      const tolerance = 1e-5;
      const maxIterations = 50000000; // Increased further for larger targets

      for (let i = 0; i < maxIterations; i++) {
        const fx = integralFunction(x);
        const fPrimeX = derivativeFunction(x);

        if (Math.abs(fx) < tolerance) {
          return x;
        }

        if (fPrimeX === 0) {
          throw new Error('Derivative is zero, cannot continue iteration.');
        }

        // Introduce dynamic damping to prevent overshooting
        let step = fx / fPrimeX;
        step = Math.min(step, x * 0.1); // Limit step size to a fraction of current x
        x = x - step;

        // Check if the step size is sufficiently small to declare convergence
        if (Math.abs(step) < tolerance) {
          return x;
        }
      }

      throw new Error(
        'Solver did not converge within the maximum number of iterations.',
      );
    }

    try {
      const x = findXForTarget(price);

      return {
        price,
        x,
        token,
      };
    } catch (error: any) {
      return {
        error: error.message,
      };
    }
  }
}
