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
import { InjectRepository } from '@nestjs/typeorm';
import { paginate } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { Tx } from '../entities/tx.entity';
import { ApiOkResponsePaginated } from '@/utils/api-type';

@Controller('v2/mdw/txs')
@ApiTags('MDW Transactions')
export class TxsController {
  constructor(
    @InjectRepository(Tx)
    private readonly txRepository: Repository<Tx>,
  ) {}

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: [
      'hash',
      'block_hash',
      'block_height',
      'version',
      'micro_index',
      'micro_time',
      'type',
      'contract_id',
      'function',
      'caller_id',
      'sender_id',
      'recipient_id',
      'created_at',
    ],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({
    operationId: 'listAllTxs',
    summary: 'Get all transactions',
    description:
      'Retrieve a paginated list of all transactions with optional sorting',
  })
  @ApiOkResponsePaginated(Tx)
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'block_height',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
  ) {
    const query = this.txRepository.createQueryBuilder('tx');

    if (orderBy) {
      query.orderBy(`tx.${orderBy}`, orderDirection);
    }

    return paginate(query, { page, limit });
  }

  @ApiParam({ name: 'hash', type: 'string', description: 'Transaction hash' })
  @ApiOperation({
    operationId: 'getTxByHash',
    summary: 'Get transaction by hash',
    description: 'Retrieve a specific transaction by its hash',
  })
  @ApiOkResponse({
    type: Tx,
    description: 'Transaction retrieved successfully',
  })
  @Get(':hash')
  async getByHash(@Param('hash') hash: string) {
    const tx = await this.txRepository.findOne({
      where: { hash },
    });

    if (!tx) {
      throw new NotFoundException(`Transaction with hash "${hash}" not found`);
    }

    return tx;
  }
}

