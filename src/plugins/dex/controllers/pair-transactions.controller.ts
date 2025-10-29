import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiOkResponse,
} from '@nestjs/swagger';
import { PairTransactionService } from '@/dex/services/pair-transaction.service';
import { PairTransactionDto } from '@/dex/dto';
import { ApiOkResponsePaginated } from '@/utils/api-type';

@Controller('dex/transactions')
@ApiTags('DEX')
export class PairTransactionsController {
  constructor(
    private readonly pairTransactionService: PairTransactionService,
  ) {}

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['created_at', 'tx_type'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiQuery({
    name: 'pair_address',
    type: 'string',
    required: false,
    description: 'Filter by specific pair address',
  })
  @ApiQuery({
    name: 'token_address',
    type: 'string',
    required: false,
    description: 'Filter by account address',
  })
  @ApiQuery({
    name: 'account_address',
    type: 'string',
    required: false,
    description: 'Filter by account address',
  })
  @ApiQuery({
    name: 'tx_type',
    type: 'string',
    required: false,
    description: 'Filter by transaction type',
  })
  @ApiOperation({
    operationId: 'listAllPairTransactions',
    summary: 'Get all pair transactions',
    description:
      'Retrieve a paginated list of all DEX pair transactions with optional filtering and sorting',
  })
  @ApiOkResponsePaginated(PairTransactionDto)
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'created_at',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
    @Query('pair_address') pairAddress?: string,
    @Query('token_address') tokenAddress?: string,
    @Query('tx_type') txType?: string,
    @Query('account_address') account_address?: string,
  ) {
    return this.pairTransactionService.findAll(
      { page, limit },
      orderBy,
      orderDirection,
      pairAddress,
      txType,
      account_address,
      tokenAddress,
    );
  }

  @ApiParam({
    name: 'txHash',
    type: 'string',
    description: 'Transaction hash',
  })
  @ApiOperation({
    operationId: 'getPairTransactionByTxHash',
    summary: 'Get pair transaction by transaction hash',
    description: 'Retrieve a specific pair transaction by its transaction hash',
  })
  @ApiOkResponse({ type: PairTransactionDto })
  @Get(':txHash')
  async getByTxHash(@Param('txHash') txHash: string) {
    const pairTransaction =
      await this.pairTransactionService.findByTxHash(txHash);
    if (!pairTransaction) {
      throw new NotFoundException(
        `Pair transaction with hash ${txHash} not found`,
      );
    }
    return pairTransaction;
  }

  @ApiParam({
    name: 'pairAddress',
    type: 'string',
    description: 'Pair contract address',
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: ['created_at', 'tx_type'],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({
    operationId: 'getPairTransactionsByPairAddress',
    summary: 'Get pair transactions by pair address',
    description: 'Retrieve paginated transactions for a specific pair',
  })
  @ApiOkResponsePaginated(PairTransactionDto)
  @Get('pair/:pairAddress')
  async getByPairAddress(
    @Param('pairAddress') pairAddress: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'created_at',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
  ) {
    return this.pairTransactionService.findByPairAddress(
      pairAddress,
      { page, limit },
      orderBy,
      orderDirection,
    );
  }
}


