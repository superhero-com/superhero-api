import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { BclTransactionsService } from '../services/bcl-transactions.service';
import { BclTransactionDto } from '../dto/bcl-transaction.dto';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { Pagination } from 'nestjs-typeorm-paginate';

@Controller('bcl/transactions')
@ApiTags('BCL')
export class BclTransactionsController {
  constructor(
    private readonly bclTransactionsService: BclTransactionsService,
  ) {}

  @ApiQuery({
    name: 'token_address',
    type: 'string',
    description: 'Token sale address',
    required: false,
  })
  @ApiQuery({
    name: 'account_address',
    type: 'string',
    description: 'Filter transactions made by this account address',
    required: false,
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOperation({
    operationId: 'listBclTransactions',
    summary: 'Get all BCL transactions',
    description:
      'Retrieve a paginated list of BCL transactions (buy/sell)',
  })
  @ApiOkResponsePaginated(BclTransactionDto)
  @Get()
  async findAll(
    @Query('token_address') token_address?: string,
    @Query('account_address') account_address?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ): Promise<Pagination<BclTransactionDto>> {
    return this.bclTransactionsService.findAll(
      { page, limit },
      {
        token_address,
        account_address,
      },
    );
  }
}

