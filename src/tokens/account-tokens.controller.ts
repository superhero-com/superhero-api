import { CommunityFactoryService } from '@/ae/community-factory.service';
import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Pagination, paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { ApiOkResponsePaginated } from '../utils/api-type';
import { TokenHolderDto } from './dto/token-holder.dto';
import { TokenHolder } from './entities/token-holders.entity';
import { Token } from './entities/token.entity';
import { TokensService } from './tokens.service';

@Controller('accounts')
@ApiTags('Account Tokens')
export class AccountTokensController {
  constructor(
    @InjectRepository(TokenHolder)
    private readonly tokenHolderRepository: Repository<TokenHolder>,
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>,
    private readonly communityFactoryService: CommunityFactoryService,
    private readonly tokensService: TokensService,
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
    // when it's creator_address or owner_address, we should fetch all tokens based no matter if the balance is 0 or not
    if (creator_address || owner_address) {
      const queryBuilder = this.tokenRepository.createQueryBuilder('token');
      if (creator_address) {
        queryBuilder.where('token.creator_address = :address', {
          address: address,
        });
      }
      if (owner_address) {
        queryBuilder.orWhere('token.owner_address = :address', {
          address: address,
        });
      }
      const tokensQueryResult = await paginate<Token>(queryBuilder, {
        page,
        limit,
      });
      // get the token holders for each token
      const tokenHoldersQueryBuilder =
        await this.tokenHolderRepository.createQueryBuilder('token_holder');
      tokenHoldersQueryBuilder.where('token_holder.address = :address', {
        address: owner_address || creator_address,
      });

      const holdings = await tokenHoldersQueryBuilder.getMany();
      return {
        ...tokensQueryResult,
        items: tokensQueryResult.items?.map((token) => ({
          token,
          address: owner_address || creator_address,
          balance:
            holdings.find((holder) => holder.aex9_address === token.address)
              ?.balance || '0',
        })),
      } as any;
    }
    const queryBuilder =
      this.tokenHolderRepository.createQueryBuilder('token_holder');

    queryBuilder.orderBy(`token_holder.amount`, 'DESC');
    queryBuilder.where('token_holder.address = :address', {
      address: address,
    });
    queryBuilder.orderBy(`token_holder.${orderBy}`, orderDirection);
    queryBuilder.leftJoinAndSelect(
      Token,
      'token',
      'token.address = token_holder.aex9_address',
    );

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
    } else if (owner_address) {
      queryBuilder.andWhere('token.owner_address = :owner_address', {
        owner_address,
      });
    } else {
      queryBuilder.andWhere('token_holder.balance > 0');
    }

    if (search) {
      queryBuilder.andWhere('token.name ILIKE :search', {
        search: `%${search}%`,
      });
    }

    // Get the token holders with their tokens
    const tokenHolders = await paginate<TokenHolder>(queryBuilder, {
      page,
      limit,
    });

    // Get the token ranks for all tokens in the result
    const tokenIds = tokenHolders.items
      .map((holder) => holder.aex9_address)
      .filter(
        (aex9_address): aex9_address is string => aex9_address !== undefined,
      );

    const tokenRanks = await this.tokensService.getTokenRanksByAex9Address(
      tokenIds as any,
    );

    const tokens = await this.tokensService.getTokensByAex9Address(
      tokenIds as any,
    );

    // Merge the rank information into the token holders
    tokenHolders.items.forEach((holder) => {
      if (holder.aex9_address) {
        const token = tokens.find(
          (token) => token.address === holder.aex9_address,
        );
        (holder as any).token = {
          ...token,
          rank: tokenRanks.get(holder.aex9_address as any),
        };
      }
    });

    return tokenHolders;
  }
}
