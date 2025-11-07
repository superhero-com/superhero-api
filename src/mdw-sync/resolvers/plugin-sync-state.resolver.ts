import { Resolver, Query, Args, Int } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PluginSyncState } from '../entities/plugin-sync-state.entity';
import { paginate } from 'nestjs-typeorm-paginate';
import { PaginatedResponse } from '../types/pagination.type';

const PaginatedPluginSyncStateResponse = PaginatedResponse(PluginSyncState);

@Resolver(() => PluginSyncState)
export class PluginSyncStateResolver {
  constructor(
    @InjectRepository(PluginSyncState)
    private readonly pluginSyncStateRepository: Repository<PluginSyncState>,
  ) {}

  @Query(() => PaginatedPluginSyncStateResponse, { name: 'pluginSyncStates' })
  async findAll(
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 })
    page: number = 1,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 100 })
    limit: number = 100,
    @Args('orderBy', { type: () => String, nullable: true })
    orderBy?: string,
    @Args('orderDirection', { type: () => String, nullable: true })
    orderDirection?: 'ASC' | 'DESC',
  ) {
    const query =
      this.pluginSyncStateRepository.createQueryBuilder('plugin_sync_state');

    if (orderBy) {
      query.orderBy(
        `plugin_sync_state.${orderBy}`,
        orderDirection || 'ASC',
      );
    } else {
      query.orderBy('plugin_sync_state.plugin_name', 'ASC');
    }

    const result = await paginate(query, { page, limit });
    return {
      items: result.items,
      metaInfo: result.meta,
    };
  }

  @Query(() => PluginSyncState, { name: 'pluginSyncState', nullable: true })
  async findOne(
    @Args('pluginName', { type: () => String }) pluginName: string,
  ) {
    return this.pluginSyncStateRepository.findOne({
      where: { plugin_name: pluginName },
    });
  }
}

