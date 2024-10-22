import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Pagination, paginate } from 'nestjs-typeorm-paginate';
import { ApiOkResponsePaginated } from 'src/tokens/tmp/api-type';
import { TokensService } from 'src/tokens/tokens.service';
import { Repository } from 'typeorm';
import { TransactionDto } from '../dto/transaction.dto';
import { Transaction } from '../entities/transaction.entity';

@Controller('api/transactions')
@ApiTags('Transactions')
export class TransactionsController {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,

    private tokenService: TokensService,
  ) {}

  @ApiQuery({
    name: 'token_address',
    type: 'string',
    description: 'Token address sale address',
    required: false,
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'account_address',
    type: 'string',
    required: false,
    description: 'Filter Transaction Made by this account address',
  })
  @ApiOperation({ operationId: 'listTransactions' })
  @ApiOkResponsePaginated(TransactionDto)
  @Get('')
  async listTransactions(
    @Query('token_address') token_address: string,
    @Query('account_address') account_address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ): Promise<Pagination<Transaction>> {
    const queryBuilder =
      this.transactionsRepository.createQueryBuilder('transactions');
    queryBuilder.orderBy(`transactions.created_at`, 'DESC');

    if (token_address) {
      const token = await this.tokenService.getToken(token_address);
      queryBuilder.where('transactions.tokenId = :tokenId', {
        tokenId: token.id,
      });
    }

    if (account_address) {
      queryBuilder
        .andWhere('transactions.address = :account_address', {
          account_address,
        })
        .leftJoin('transactions.token', 'token')
        .addSelect([
          'token.name',
          'token.symbol',
          'token.address',
          'token.sale_address',
          'token.rank',
          'token.category',
        ]);
    }

    return paginate<Transaction>(queryBuilder, { page, limit });
  }
}
