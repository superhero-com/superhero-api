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
import { PluginSyncState } from '../entities/plugin-sync-state.entity';
import { ApiOkResponsePaginated } from '@/utils/api-type';

@Controller('v2/mdw/plugin-sync-state')
@ApiTags('MDW Plugin Sync State')
export class PluginSyncStateController {
  constructor(
    @InjectRepository(PluginSyncState)
    private readonly pluginSyncStateRepository: Repository<PluginSyncState>,
  ) {}

  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'order_by',
    enum: [
      'plugin_name',
      'version',
      'last_synced_height',
      'start_from_height',
      'is_active',
      'created_at',
      'updated_at',
    ],
    required: false,
  })
  @ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false })
  @ApiOperation({
    operationId: 'listAllPluginSyncStates',
    summary: 'Get all plugin sync states',
    description:
      'Retrieve a paginated list of all plugin sync states with optional sorting',
  })
  @ApiOkResponsePaginated(PluginSyncState)
  @Get()
  async listAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('order_by') orderBy: string = 'plugin_name',
    @Query('order_direction') orderDirection: 'ASC' | 'DESC' = 'ASC',
  ) {
    const query =
      this.pluginSyncStateRepository.createQueryBuilder('plugin_sync_state');

    if (orderBy) {
      query.orderBy(`plugin_sync_state.${orderBy}`, orderDirection);
    }

    const result = await paginate(query, { page, limit });
    return {
      items: result.items,
      metaInfo: result.meta,
    };
  }

  @ApiParam({
    name: 'plugin_name',
    type: 'string',
    description: 'Plugin name',
  })
  @ApiOperation({
    operationId: 'getPluginSyncStateByPluginName',
    summary: 'Get plugin sync state by plugin name',
    description: 'Retrieve a specific plugin sync state by its plugin name',
  })
  @ApiOkResponse({
    type: PluginSyncState,
    description: 'Plugin sync state retrieved successfully',
  })
  @Get(':plugin_name')
  async getByPluginName(@Param('plugin_name') pluginName: string) {
    const pluginSyncState = await this.pluginSyncStateRepository.findOne({
      where: { plugin_name: pluginName },
    });

    if (!pluginSyncState) {
      throw new NotFoundException(
        `Plugin sync state with plugin name "${pluginName}" not found`,
      );
    }

    return pluginSyncState;
  }
}

