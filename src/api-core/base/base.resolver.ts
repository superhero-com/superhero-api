import { Resolver, Query, Args, Int } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { paginate } from 'nestjs-typeorm-paginate';
import { PaginatedResponse } from '../types/pagination.type';
import { EntityConfig } from '../types/entity-config.interface';
import { getSortableFields, getSearchableFields } from '../utils/metadata-reader';

export function createBaseResolver<T>(config: EntityConfig<T>) {
  const PaginatedResponseType = PaginatedResponse(config.entity);
  
  // Read sortable and searchable fields from entity metadata
  const sortableFields = getSortableFields(config.entity);
  const searchableFields = getSearchableFields(config.entity);

  @Resolver(() => config.entity)
  class BaseResolver {
    constructor(
      @InjectRepository(config.entity)
      public readonly repository: Repository<T>,
    ) {}

    @Query(() => PaginatedResponseType, { name: config.queryNames.plural })
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
      const query = this.repository.createQueryBuilder(config.tableAlias);

      // Note: GraphQL filtering by searchable fields can be added by extending this resolver
      // and adding @Args decorators for each searchable field, then applying filters similar
      // to how it's done in the REST API BaseController

      // Apply ordering
      if (orderBy) {
        query.orderBy(
          `${config.tableAlias}.${orderBy}`,
          orderDirection || config.defaultOrderDirection || 'DESC',
        );
      } else {
        query.orderBy(
          `${config.tableAlias}.${config.defaultOrderBy}`,
          config.defaultOrderDirection || 'DESC',
        );
      }

      const result = await paginate(query, { page, limit });
      return {
        items: result.items,
        metaInfo: result.meta,
      };
    }

    @Query(() => config.entity, {
      name: config.queryNames.singular,
      nullable: true,
    })
    async findOne(
      @Args(config.primaryKey, { type: () => String }) id: string,
    ) {
      return this.repository.findOne({
        where: { [config.primaryKey]: id } as any,
      });
    }
  }

  // Note: Custom ResolveFields should be added by extending this class
  // or by using a mixin pattern. For now, entities with custom ResolveFields
  // will need to extend BaseResolver and add their own methods.

  return BaseResolver;
}

