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
import { TokenDto } from './dto/token.dto';
import { Token } from './entities/token.entity';
import { ApiOkResponsePaginated } from './tmp/api-type';
import { TokensService } from './tokens.service';
import { TokenHistory } from './entities/token-history.entity';
import { TokenTransactionDto } from './dto/token-transaction.dto';
import { TokenHolderDto } from './dto/token-holder.dto';
import { TokenHolder } from './entities/token-holders.entity';
import { TokenTransaction } from './entities/token-transaction.entity';
import { InjectQueue } from '@nestjs/bull';
import { PULL_TOKEN_META_DATA_QUEUE } from 'src/token-sale/queues';
import { Queue } from 'bull';

@Controller('api/tokens')
@ApiTags('Tokens')
export class TokensController {
  constructor(
    @InjectRepository(Token)
    private readonly tokensRepository: Repository<Token>,

    @InjectRepository(TokenTransaction)
    private readonly tokenTransactionsRepository: Repository<TokenTransaction>,

    @InjectRepository(TokenHistory)
    private readonly tokenHistoryRepository: Repository<TokenHistory>,

    @InjectRepository(TokenHolder)
    private readonly tokenHolderRepository: Repository<TokenHolder>,

    private readonly tokensService: TokensService,

    @InjectQueue(PULL_TOKEN_META_DATA_QUEUE)
    private readonly pullTokenMetaDataQueue: Queue,
  ) {}

  @ApiQuery({ name: 'search', type: 'string', required: false })
  @ApiQuery({ name: 'factory_address', type: 'string', required: false })
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
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'market_cap',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
    @Query('category') category: 'all' | 'word' | 'number' = 'all',
  ): Promise<Pagination<Token>> {
    const queryBuilder = this.tokensRepository.createQueryBuilder('token');
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
    return paginate<Token>(queryBuilder, { page, limit });
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
    const token = await this.tokensService.findByAddress(address);

    if (token) {
      return token;
    }

    await this.pullTokenMetaDataQueue.add({
      saleAddress: address,
    });
    return this.tokensService.findByAddress(address);
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
  @ApiQuery({
    name: 'account',
    type: 'string',
    required: false,
    description: 'Filter Transaction Made by this account address',
  })
  @ApiOperation({ operationId: 'listTokenTransactions' })
  @ApiOkResponsePaginated(TokenTransactionDto)
  @Get(':address/transactions')
  async listTokenTransactions(
    @Param('address') address: string,
    @Query('account') account: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ): Promise<Pagination<TokenTransaction>> {
    const token = await this.tokensService.findByAddress(address);
    const queryBuilder =
      this.tokenTransactionsRepository.createQueryBuilder('token_transactions');
    queryBuilder.orderBy(`token_transactions.created_at`, 'DESC');
    queryBuilder.where('token_transactions.tokenId = :tokenId', {
      tokenId: token.id,
    });

    if (account) {
      queryBuilder.andWhere('token_history.address = :account', { account });
    }

    return paginate<TokenTransaction>(queryBuilder, { page, limit });
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
}
