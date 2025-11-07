import { Resolver, Query, Args, Int } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncState } from '../entities/sync-state.entity';
import { paginate } from 'nestjs-typeorm-paginate';

@Resolver(() => SyncState)
export class SyncStateResolver {
  constructor(
    @InjectRepository(SyncState)
    private readonly syncStateRepository: Repository<SyncState>,
  ) {}

  @Query(() => [SyncState], { name: 'syncStates' })
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
    const query = this.syncStateRepository.createQueryBuilder('sync_state');

    if (orderBy) {
      query.orderBy(`sync_state.${orderBy}`, orderDirection || 'ASC');
    } else {
      query.orderBy('sync_state.id', 'ASC');
    }

    const result = await paginate(query, { page, limit });
    return result.items;
  }

  @Query(() => SyncState, { name: 'syncState', nullable: true })
  async findOne(@Args('id', { type: () => String }) id: string) {
    return this.syncStateRepository.findOne({
      where: { id },
    });
  }
}

