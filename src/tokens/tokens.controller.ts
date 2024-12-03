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
import BigNumber from 'bignumber.js';
import { ROOM_FACTORY_CONTRACTS } from 'src/ae/utils/constants';
import { ACTIVE_NETWORK } from 'src/ae/utils/networks';

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
    } else {
      const factory_addresses = ROOM_FACTORY_CONTRACTS[
        ACTIVE_NETWORK.networkId
      ].map((f) => f.contractId);

      queryBuilder.andWhere(
        'token.factory_address IN (:...factory_addresses)',
        {
          factory_addresses,
        },
      );
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

  @ApiQuery({ name: 'price', type: 'number', required: true })
  @ApiQuery({ name: 'token_address', type: 'string', required: false })
  @ApiQuery({ name: 'factory_address', type: 'string', required: false })
  @ApiQuery({ name: 'supply', type: 'string', required: false })
  @ApiOperation({ operationId: 'estimatePrice' })
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
            Math.exp(0.0000005 * (supply + x)) / 0.0000005 -
            Math.exp(0.0000005 * supply) / 0.0000005 -
            0.999999 * x -
            targetValue
          );
        }

        // Set an initial guess dynamically based on the target
        const initialGuess = Math.max(1000000, targetValue * 1000);

        // Define the tolerance and the maximum number of iterations
        const tolerance = 1e-5;
        const maxIterations = 50000000;

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
          } else {
            low = x; // If no sign change, move the low bound
          }
          x = (low + high) / 2; // New midpoint
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
      ct_pykmqDUUf8iNvVNq2vQgW7qY6zo83HAUogqXhgJuT1BPpymNf: (
        targetValue,
        supply,
      ) => {
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
            console.log('low', low, low + high / 2);
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
      ct_2UnNEeTTBMct4ykx9kMzeEXGqgBMAPxYLW2XGGvR3uTDJQPdVa: (
        targetValue,
        supply,
      ) => {
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
            console.log('low', low, low + high / 2);
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
      console.log('Using custom calculator for token', factoryAddress);
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
