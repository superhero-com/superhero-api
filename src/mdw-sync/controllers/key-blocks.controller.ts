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
import { KeyBlock } from '../entities/key-block.entity';
import { ApiOkResponsePaginated } from '@/utils/api-type';

@Controller('v2/mdw/key-blocks')
@ApiTags('MDW Key Blocks')
export class KeyBlocksController {
  constructor(
    @InjectRepository(KeyBlock)
    private readonly keyBlockRepository: Repository<KeyBlock>,
  ) {}

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: [
      'height',
      'hash',
      'prev_hash',
      'prev_key_hash',
      'state_hash',
      'beneficiary',
      'miner',
      'time',
      'transactions_count',
      'micro_blocks_count',
      'beneficiary_reward',
      'nonce',
      'target',
      'version',
      'created_at',
    ],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({
    operationId: 'listAllKeyBlocks',
    summary: 'Get all key blocks',
    description:
      'Retrieve a paginated list of all key blocks with optional sorting',
  })
  @ApiOkResponsePaginated(KeyBlock)
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'height',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
  ) {
    const query = this.keyBlockRepository.createQueryBuilder('key_block');

    if (orderBy) {
      query.orderBy(`key_block.${orderBy}`, orderDirection);
    }

    return paginate(query, { page, limit });
  }

  @ApiParam({ name: 'hash', type: 'string', description: 'Key block hash' })
  @ApiOperation({
    operationId: 'getKeyBlockByHash',
    summary: 'Get key block by hash',
    description: 'Retrieve a specific key block by its hash',
  })
  @ApiOkResponse({
    type: KeyBlock,
    description: 'Key block retrieved successfully',
  })
  @Get(':hash')
  async getByHash(@Param('hash') hash: string) {
    const keyBlock = await this.keyBlockRepository.findOne({
      where: { hash },
    });

    if (!keyBlock) {
      throw new NotFoundException(`Key block with hash "${hash}" not found`);
    }

    return keyBlock;
  }
}

