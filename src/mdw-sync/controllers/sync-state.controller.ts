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
import { SyncState } from '../entities/sync-state.entity';
import { ApiOkResponsePaginated } from '@/utils/api-type';

@Controller('v2/mdw/sync-state')
@ApiTags('MDW Sync State')
export class SyncStateController {
  constructor(
    @InjectRepository(SyncState)
    private readonly syncStateRepository: Repository<SyncState>,
  ) {}

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: [
      'id',
      'last_synced_height',
      'tip_height',
      'is_bulk_mode',
      'backward_synced_height',
      'live_synced_height',
      'created_at',
      'updated_at',
    ],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({
    operationId: 'listAllSyncStates',
    summary: 'Get all sync states',
    description:
      'Retrieve a paginated list of all sync states with optional sorting',
  })
  @ApiOkResponsePaginated(SyncState)
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'id',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'ASC',
  ) {
    const query = this.syncStateRepository.createQueryBuilder('sync_state');

    if (orderBy) {
      query.orderBy(`sync_state.${orderBy}`, orderDirection);
    }

    const result = await paginate(query, { page, limit });
    return {
      items: result.items,
      metaInfo: result.meta,
    };
  }

  @ApiParam({ name: 'id', type: 'string', description: 'Sync state ID' })
  @ApiOperation({
    operationId: 'getSyncStateById',
    summary: 'Get sync state by ID',
    description: 'Retrieve a specific sync state by its ID',
  })
  @ApiOkResponse({
    type: SyncState,
    description: 'Sync state retrieved successfully',
  })
  @Get(':id')
  async getById(@Param('id') id: string) {
    const syncState = await this.syncStateRepository.findOne({
      where: { id },
    });

    if (!syncState) {
      throw new NotFoundException(`Sync state with ID "${id}" not found`);
    }

    return syncState;
  }
}

