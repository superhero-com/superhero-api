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
import { EntityConfig, RelationConfig } from '../types/entity-config.interface';
import { getSortableFields, getSearchableFields } from '../utils/metadata-reader';
import { parseIncludesToTree } from '../utils/includes-parser';
import {
  applyIncludesToQueryBuilder,
  EntityConfigRegistry,
  resolveRelation,
} from '../utils/relation-loader';

/**
 * Builds a description of available relations for Swagger documentation
 * @param entityConfig - The entity config
 * @param configRegistry - Registry to look up related entity configs
 * @param depth - Current recursion depth (to prevent infinite loops)
 * @param parentPath - Path prefix for nested relations (e.g., "txs.")
 * @returns Description string listing available relations
 */
function buildIncludesDescription(
  entityConfig: EntityConfig<any>,
  configRegistry?: EntityConfigRegistry,
  depth: number = 0,
  parentPath: string = '',
): string {
  if (depth > 3) {
    return ''; // Prevent infinite recursion
  }

  if (!entityConfig.relations || entityConfig.relations.length === 0) {
    return '';
  }

  const relationNames: string[] = [];

  for (const relation of entityConfig.relations) {
    const relationPath = parentPath ? `${parentPath}.${relation.field}` : relation.field;
    relationNames.push(relationPath);

    // Recursively get nested relations if registry is available
    if (configRegistry && depth < 2) {
      const relatedEntityConfig = configRegistry.get(relation.relatedEntity);
      if (relatedEntityConfig && relatedEntityConfig.relations && relatedEntityConfig.relations.length > 0) {
        const nestedNames = buildIncludesDescription(
          relatedEntityConfig,
          configRegistry,
          depth + 1,
          relationPath,
        );
        if (nestedNames) {
          // Add nested relations to the list
          nestedNames.split(', ').forEach((name) => {
            if (name.trim()) {
              relationNames.push(name.trim());
            }
          });
        }
      }
    }
  }

  return relationNames.join(', ');
}

/**
 * Limits array relations to 50 items in the result
 * @param items - Array of entities (can be paginated result items)
 * @param entityConfig - The entity config
 * @param configRegistry - Registry to look up relation configs
 * @param includesTree - The includes tree structure
 */
function limitArrayRelations<T>(
  items: T[],
  entityConfig: EntityConfig<T>,
  configRegistry: EntityConfigRegistry,
  includesTree: any,
): void {
  if (!items || items.length === 0) {
    return;
  }

  for (const [relationField, nestedIncludes] of Object.entries(includesTree)) {
    const relationConfig = resolveRelation(entityConfig, relationField);
    if (!relationConfig || !relationConfig.isArray) {
      continue;
    }

    // Limit array relations to 50 items
    for (const item of items) {
      const relationValue = (item as any)[relationField];
      if (Array.isArray(relationValue) && relationValue.length > 50) {
        (item as any)[relationField] = relationValue.slice(0, 50);
      }
    }

    // Recursively process nested includes
    if (Object.keys(nestedIncludes).length > 0) {
      const relatedEntityConfig = configRegistry.get(relationConfig.relatedEntity);
      if (relatedEntityConfig) {
        for (const item of items) {
          const relationValue = (item as any)[relationField];
          if (Array.isArray(relationValue)) {
            limitArrayRelations(
              relationValue,
              relatedEntityConfig,
              configRegistry,
              nestedIncludes,
            );
          } else if (relationValue) {
            limitArrayRelations(
              [relationValue],
              relatedEntityConfig,
              configRegistry,
              nestedIncludes,
            );
          }
        }
      }
    }
  }
}

export function createBaseController<T>(
  config: EntityConfig<T>,
  configRegistry?: EntityConfigRegistry,
) {
  const ResponseType = config.dto || config.entity;
  
  // Read sortable and searchable fields from entity metadata
  const sortableFields = getSortableFields(config.entity);
  const searchableFields = getSearchableFields(config.entity);
  
  // Use sortable fields from metadata if orderByFields not provided in config
  const orderByFields = config.orderByFields || sortableFields.map(f => f.field);
  
  // Build includes description only if relations exist
  const hasRelations = config.relations && config.relations.length > 0;
  let includesDescription = '';
  let exampleRelation = '';
  
  if (hasRelations) {
    const availableRelations = buildIncludesDescription(config, configRegistry);
    const firstRelation = config.relations![0];
    exampleRelation = firstRelation.field;
    // Try to find a nested relation example
    if (firstRelation.isArray && configRegistry) {
      const relatedConfig = configRegistry.get(firstRelation.relatedEntity);
      if (relatedConfig?.relations && relatedConfig.relations.length > 0) {
        exampleRelation = `${firstRelation.field},${firstRelation.field}.${relatedConfig.relations[0].field}`;
      }
    }
    
    includesDescription = `Comma-separated list of relations to include. Supports nested relations. Available: ${availableRelations}${exampleRelation ? `. Example: "${exampleRelation}"` : ''}`;
  }
  
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
    // Only add includes query param if relations exist
    ...(hasRelations
      ? [
          ApiQuery({
            name: 'includes',
            type: String,
            required: false,
            description: includesDescription,
          }),
        ]
      : []),
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
  
  // Build decorators for findOne method
  const findOneDecorators: Array<MethodDecorator | PropertyDecorator> = [
    ApiParam({
      name: config.primaryKey,
      type: 'string',
      description: `${config.queryNames.singular} ${config.primaryKey}`,
    }),
    ...(hasRelations
      ? [
          ApiQuery({
            name: 'includes',
            type: String,
            required: false,
            description: includesDescription,
          }),
        ]
      : []),
    ApiOperation({
      operationId: `get${config.queryNames.singular}By${config.primaryKey.charAt(0).toUpperCase() + config.primaryKey.slice(1)}`,
      summary: `Get ${config.queryNames.singular} by ${config.primaryKey}`,
      description: `Retrieve a specific ${config.queryNames.singular} by its ${config.primaryKey}`,
    }),
    ApiOkResponse({
      type: ResponseType,
      description: `${config.queryNames.singular} retrieved successfully`,
    }),
  ];
  
  const findOneDecoratorsCombined = applyDecorators(...findOneDecorators);
  
  @Controller(config.routePrefix)
  @ApiTags(config.swaggerTag)
  @ApiExtraModels(ResponseType)
  class BaseController {
    public readonly configRegistry: EntityConfigRegistry | undefined;

    constructor(
      @InjectRepository(config.entity)
      public readonly repository: Repository<T>,
    ) {
      // Store configRegistry in the instance
      (this as any).configRegistry = configRegistry;
    }

    @listAllDecorators
    @Get()
    async listAll(
      @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
      @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
      @Query('order_by') orderBy: string = config.defaultOrderBy,
      @Query('order_direction')
      orderDirection: 'ASC' | 'DESC' = config.defaultOrderDirection || 'DESC',
      @Query('includes') includes?: string,
      @Query() allQueryParams?: Record<string, any>,
    ) {
      const query = this.repository.createQueryBuilder(config.tableAlias);

      // Apply includes if provided (must be done before other query modifications)
      if (includes && this.configRegistry) {
        const includesTree = parseIncludesToTree(includes);
        applyIncludesToQueryBuilder(
          query,
          config,
          includesTree,
          this.configRegistry,
        );
      }

      // Apply filters from searchable fields
      // Exclude pagination and sorting parameters from filters
      if (allQueryParams) {
        const excludedParams = ['page', 'limit', 'order_by', 'order_direction', 'includes'];
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

      // Limit array relations to 50 items if includes were used
      if (includes && this.configRegistry) {
        const includesTree = parseIncludesToTree(includes);
        limitArrayRelations(result.items, config, this.configRegistry, includesTree);
      }

      return {
        items: result.items,
        metaInfo: result.meta,
      };
    }

    @findOneDecoratorsCombined
    @Get(`:${config.primaryKey}`)
    async findOne(
      @Param(config.primaryKey) id: string,
      @Query('includes') includes?: string,
    ) {
      const query = this.repository.createQueryBuilder(config.tableAlias);

      // Apply where condition
      query.where(`${config.tableAlias}.${config.primaryKey} = :id`, { id });

      // Apply includes if provided
      if (includes && this.configRegistry) {
        const includesTree = parseIncludesToTree(includes);
        applyIncludesToQueryBuilder(
          query,
          config,
          includesTree,
          this.configRegistry,
        );
      }

      const entity = await query.getOne();

      if (!entity) {
        throw new NotFoundException(
          `${config.queryNames.singular} with ${config.primaryKey} "${id}" not found`,
        );
      }

      // Limit array relations to 50 items if includes were used
      if (includes && this.configRegistry) {
        const includesTree = parseIncludesToTree(includes);
        limitArrayRelations([entity], config, this.configRegistry, includesTree);
      }

      return entity;
    }
  }

  return BaseController;
}

