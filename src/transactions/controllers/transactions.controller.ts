import { CommunityFactoryService } from '@/ae/community-factory.service';
import { ACTIVE_NETWORK } from '@/configs/network';
import { TokensService } from '@/tokens/tokens.service';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { fetchJson } from '@/utils/common';
import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Pagination, paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { TransactionDto } from '../dto/transaction.dto';
import { Transaction } from '../entities/transaction.entity';
import { TransactionService } from '../services/transaction.service';

@Controller('transactions')
@ApiTags('Transactions')
export class TransactionsController {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,
    private readonly communityFactoryService: CommunityFactoryService,
    private tokenService: TokensService,

    private transactionService: TransactionService,
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
    name: 'includes',
    enum: ['token'],
    required: false,
  })
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
    @Query('token_address') token_address: string = undefined,
    @Query('account_address') account_address: string = undefined,
    @Query('includes') includes: string = undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ): Promise<Pagination<Transaction>> {
    const queryBuilder =
      this.transactionsRepository.createQueryBuilder('transactions');
    if (includes === 'token' || account_address) {
      queryBuilder.leftJoinAndMapOne(
        'transactions.token',
        'token',
        'token',
        'token.sale_address = transactions.sale_address',
      );
    } else {
      queryBuilder.leftJoinAndSelect(
        'token',
        'token',
        'token.sale_address = transactions.sale_address',
      );
    }
    queryBuilder.orderBy(`transactions.created_at`, 'DESC');

    if (token_address) {
      const token = await this.tokenService.getToken(token_address);
      queryBuilder.where('transactions.sale_address = :sale_address', {
        sale_address: token.sale_address,
      });
    } else {
      const factory = await this.communityFactoryService.getCurrentFactory();
      queryBuilder.where('token.factory_address = :factoryAddress', {
        factoryAddress: factory.address,
      });
    }

    if (account_address) {
      queryBuilder
        .andWhere('transactions.address = :account_address', {
          account_address,
        })
        .addSelect([
          'token.name',
          'token.symbol',
          'token.address',
          'token.sale_address',
          // 'token.rank',
          'token.collection',
        ]);
    }
    const startTime = Date.now();
    const result = await paginate<Transaction>(queryBuilder, { page, limit });
    const queryMs = Date.now() - startTime;

    return {
      ...result,
      queryMs,
    } as any;
  }

  @ApiQuery({
    name: 'tx_hash',
    type: 'string',
    required: true,
    description: 'Transaction hash to fetch the transaction details',
  })
  @ApiOperation({ operationId: 'getTransactionByHash' })
  @ApiOkResponse({ type: TransactionDto })
  @Get('by-hash')
  async getTransactionByHash(
    @Query('tx_hash') tx_hash: string,
  ): Promise<TransactionDto> {
    const transaction = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .where('transactions.tx_hash = :tx_hash', { tx_hash })
      .select('transactions.*')
      .getRawOne();
    if (!transaction) {
      try {
        const mdwTransaction = await fetchJson(
          `${ACTIVE_NETWORK.middlewareUrl}/v3/txs/${tx_hash}`,
        ).then((res) => camelcaseKeysDeep(res));
        // fetch from mdw
        const tx =
          await this.transactionService.saveTransaction(mdwTransaction);
        return tx as unknown as TransactionDto;
      } catch (error) {
        throw new NotFoundException(
          `Transaction with hash ${tx_hash} not found`,
        );
      }
    }
    return transaction;
  }
}
