import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  applyDecorators,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiOkResponse,
  ApiExtraModels,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { paginate } from 'nestjs-typeorm-paginate';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { EntityConfig } from '../types/entity-config.interface';
import { getSortableFields, getSearchableFields } from '../utils/metadata-reader';

export function createBaseController<T>(config: EntityConfig<T>) {
  const ResponseType = config.dto || config.entity;
  
  // Read sortable and searchable fields from entity metadata
  const sortableFields = getSortableFields(config.entity);
  const searchableFields = getSearchableFields(config.entity);
  
  // Use sortable fields from metadata if orderByFields not provided in config
  const orderByFields = config.orderByFields || sortableFields.map(f => f.field);
  
  // Build all decorators array
  const allDecorators: Array<MethodDecorator | PropertyDecorator> = [
    ApiQuery({ name: 'page', type: 'number', required: false }),
    ApiQuery({ name: 'limit', type: 'number', required: false }),
    ApiQuery({
      name: 'order_by',
      enum: orderByFields.length > 0 ? orderByFields : undefined,
      required: false,
    }),
    ApiQuery({ name: 'order_direction', enum: ['ASC', 'DESC'], required: false }),
    // Add ApiQuery decorators for each searchable field
    ...searchableFields.map((field) =>
      ApiQuery({
        name: field.field,
        type: String,
        required: false,
        description: field.description || `Filter by ${field.field}`,
      }),
    ),
    ApiOperation({
      operationId: `listAll${config.queryNames.plural}`,
      summary: `Get all ${config.queryNames.plural}`,
      description: `Retrieve a paginated list of all ${config.queryNames.plural} with optional sorting and filtering`,
    }),
    ApiOkResponsePaginated(ResponseType),
  ];
  
  // Combine all decorators
  const listAllDecorators = applyDecorators(...allDecorators);
  
  @Controller(config.routePrefix)
  @ApiTags(config.swaggerTag)
  @ApiExtraModels(ResponseType)
  class BaseController {
    constructor(
      @InjectRepository(config.entity)
      public readonly repository: Repository<T>,
    ) {}

    @listAllDecorators
    @Get()
    async listAll(
      @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
      @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
      @Query('order_by') orderBy: string = config.defaultOrderBy,
      @Query('order_direction')
      orderDirection: 'ASC' | 'DESC' = config.defaultOrderDirection || 'DESC',
      @Query() allQueryParams?: Record<string, any>,
    ) {
      const query = this.repository.createQueryBuilder(config.tableAlias);

      // Apply filters from searchable fields
      // Exclude pagination and sorting parameters from filters
      if (allQueryParams) {
        const excludedParams = ['page', 'limit', 'order_by', 'order_direction'];
        for (const searchableField of searchableFields) {
          const filterValue = allQueryParams[searchableField.field];
          // Only apply filter if value is provided and not excluded
          if (
            filterValue !== undefined &&
            filterValue !== null &&
            filterValue !== '' &&
            !excludedParams.includes(searchableField.field)
          ) {
            if (searchableField.resolver) {
              // Use custom resolver
              searchableField.resolver(query, config.tableAlias, searchableField.field, filterValue);
            } else {
              // Default: exact match
              query.andWhere(
                `${config.tableAlias}.${searchableField.field} = :${searchableField.field}`,
                { [searchableField.field]: filterValue },
              );
            }
          }
        }
      }

      // Apply ordering
      if (orderBy) {
        query.orderBy(`${config.tableAlias}.${orderBy}`, orderDirection);
      }

      const result = await paginate(query, { page, limit });
      return {
        items: result.items,
        metaInfo: result.meta,
      };
    }

    @ApiParam({
      name: config.primaryKey,
      type: 'string',
      description: `${config.queryNames.singular} ${config.primaryKey}`,
    })
    @ApiOperation({
      operationId: `get${config.queryNames.singular}By${config.primaryKey.charAt(0).toUpperCase() + config.primaryKey.slice(1)}`,
      summary: `Get ${config.queryNames.singular} by ${config.primaryKey}`,
      description: `Retrieve a specific ${config.queryNames.singular} by its ${config.primaryKey}`,
    })
    @ApiOkResponse({
      type: ResponseType,
      description: `${config.queryNames.singular} retrieved successfully`,
    })
    @Get(`:${config.primaryKey}`)
    async findOne(@Param(config.primaryKey) id: string) {
      const entity = await this.repository.findOne({
        where: { [config.primaryKey]: id } as any,
      });

      if (!entity) {
        throw new NotFoundException(
          `${config.queryNames.singular} with ${config.primaryKey} "${id}" not found`,
        );
      }

      return entity;
    }
  }

  return BaseController;
}

