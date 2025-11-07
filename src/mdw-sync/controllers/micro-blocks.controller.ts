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
import { MicroBlock } from '../entities/micro-block.entity';
import { ApiOkResponsePaginated } from '@/utils/api-type';

@Controller('v2/mdw/micro-blocks')
@ApiTags('MDW Micro Blocks')
export class MicroBlocksController {
  constructor(
    @InjectRepository(MicroBlock)
    private readonly microBlockRepository: Repository<MicroBlock>,
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
      'time',
      'transactions_count',
      'version',
      'gas',
      'micro_block_index',
      'created_at',
    ],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({
    operationId: 'listAllMicroBlocks',
    summary: 'Get all micro blocks',
    description:
      'Retrieve a paginated list of all micro blocks with optional sorting',
  })
  @ApiOkResponsePaginated(MicroBlock)
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'height',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'DESC',
  ) {
    const query = this.microBlockRepository.createQueryBuilder('micro_block');

    if (orderBy) {
      query.orderBy(`micro_block.${orderBy}`, orderDirection);
    }

    const result = await paginate(query, { page, limit });
    return {
      items: result.items,
      metaInfo: result.meta,
    };
  }

  @ApiParam({ name: 'hash', type: 'string', description: 'Micro block hash' })
  @ApiOperation({
    operationId: 'getMicroBlockByHash',
    summary: 'Get micro block by hash',
    description: 'Retrieve a specific micro block by its hash',
  })
  @ApiOkResponse({
    type: MicroBlock,
    description: 'Micro block retrieved successfully',
  })
  @Get(':hash')
  async getByHash(@Param('hash') hash: string) {
    const microBlock = await this.microBlockRepository.findOne({
      where: { hash },
    });

    if (!microBlock) {
      throw new NotFoundException(`Micro block with hash "${hash}" not found`);
    }

    return microBlock;
  }
}

