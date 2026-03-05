import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  applyDecorators,
  UseGuards,
  BadRequestException,
  HttpStatus,
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
import { Repository } from 'typeorm';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { EntityConfig } from '../types/entity-config.interface';
import {
  getSortableFields,
  getSearchableFields,
} from '../utils/metadata-reader';
import { parseIncludesToTree } from '../utils/includes-parser';
import {
  applyIncludesToQueryBuilder,
  EntityConfigRegistry,
  resolveRelation,
  checkHasArrayRelations,
} from '../utils/relation-loader';
import { RateLimitGuard } from '../guards/rate-limit.guard';

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
    const relationPath = parentPath
      ? `${parentPath}.${relation.field}`
      : relation.field;
    relationNames.push(relationPath);

    // Recursively get nested relations if registry is available
    if (configRegistry && depth < 2) {
      const relatedEntityConfig = configRegistry.get(relation.relatedEntity);
      if (
        relatedEntityConfig &&
        relatedEntityConfig.relations &&
        relatedEntityConfig.relations.length > 0
      ) {
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
      const relatedEntityConfig = configRegistry.get(
        relationConfig.relatedEntity,
      );
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
  const orderByFields =
    config.orderByFields || sortableFields.map((f) => f.field);

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
    ApiQuery({
      name: 'order_direction',
      enum: ['ASC', 'DESC'],
      required: false,
    }),
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
  @UseGuards(RateLimitGuard)
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
      @Query('limit', new DefaultValuePipe(100), ParseIntPipe)
      limit: number = 100,
      @Query('order_by') orderBy: string = config.defaultOrderBy,
      @Query('order_direction')
      orderDirection: 'ASC' | 'DESC' = config.defaultOrderDirection || 'DESC',
      @Query('includes') includes?: string,
      @Query() allQueryParams?: Record<string, any>,
    ) {
      // Hard limit: maximum 100 items per request
      if (limit > 100) {
        throw new BadRequestException('Maximum limit is 100 items per request');
      }

      // Performance monitoring
      const _queryStartTime = Date.now();
      const _queryDate = new Date().toISOString();

      // Check if we have array relations that would cause pagination issues
      const hasArrayRelations =
        includes && this.configRegistry
          ? checkHasArrayRelations(
              config,
              parseIncludesToTree(includes),
              this.configRegistry,
            )
          : false;

      let result: any;

      if (hasArrayRelations) {
        // When we have array relations, we need to use a subquery approach:
        // 1. First get the paginated IDs of parent entities (without joins)
        // 2. Then fetch the full entities with relations using those IDs

        // Step 1: Build a query to get paginated parent IDs
        const idQuery = this.repository.createQueryBuilder(config.tableAlias);

        // Apply filters from searchable fields
        if (allQueryParams) {
          const excludedParams = [
            'page',
            'limit',
            'order_by',
            'order_direction',
            'includes',
          ];
          for (const searchableField of searchableFields) {
            const filterValue = allQueryParams[searchableField.field];
            if (
              filterValue !== undefined &&
              filterValue !== null &&
              filterValue !== '' &&
              !excludedParams.includes(searchableField.field)
            ) {
              if (searchableField.resolver) {
                searchableField.resolver(
                  idQuery,
                  config.tableAlias,
                  searchableField.field,
                  filterValue,
                );
              } else {
                idQuery.andWhere(
                  `${config.tableAlias}.${searchableField.field} = :${searchableField.field}`,
                  { [searchableField.field]: filterValue },
                );
              }
            }
          }
        }

        // Apply ordering
        if (orderBy) {
          idQuery.orderBy(`${config.tableAlias}.${orderBy}`, orderDirection);
        }

        // Get paginated IDs
        const idResult = await paginate(
          idQuery.select(`${config.tableAlias}.${config.primaryKey}`),
          { page, limit },
        );
        const ids = idResult.items.map((item: any) => item[config.primaryKey]);

        if (ids.length === 0) {
          // No results, return empty pagination
          return {
            items: [],
            metaInfo: idResult.meta,
          };
        }

        // Step 2: Fetch full entities with relations using the paginated IDs
        const query = this.repository.createQueryBuilder(config.tableAlias);

        // Filter by the paginated IDs
        query.where(`${config.tableAlias}.${config.primaryKey} IN (:...ids)`, {
          ids,
        });

        // Apply includes with relations
        const includesTree = parseIncludesToTree(includes!);
        applyIncludesToQueryBuilder(
          query,
          config,
          includesTree,
          this.configRegistry!,
        );

        // Get all entities (we already paginated by IDs)
        const entities = await query.getMany();

        // Reorder entities to match the original pagination order
        // Create a map for O(1) lookup
        const entityMap = new Map(
          entities.map((e: any) => [e[config.primaryKey], e]),
        );
        // Reorder based on the original ID order
        const orderedEntities = ids
          .map((id: any) => entityMap.get(id))
          .filter(Boolean);

        // Adjust pagination metadata to reflect actual item count
        // Some entities may not exist (e.g., due to concurrent deletion),
        // so we need to update itemCount to match the actual returned items
        const actualItemCount = orderedEntities.length;
        const adjustedMeta = {
          ...idResult.meta,
          itemCount: actualItemCount,
        };

        result = {
          items: orderedEntities,
          meta: adjustedMeta,
        };
      } else {
        // No array relations, use standard pagination
        const query = this.repository.createQueryBuilder(config.tableAlias);

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

        // Apply filters from searchable fields
        if (allQueryParams) {
          const excludedParams = [
            'page',
            'limit',
            'order_by',
            'order_direction',
            'includes',
          ];
          for (const searchableField of searchableFields) {
            const filterValue = allQueryParams[searchableField.field];
            if (
              filterValue !== undefined &&
              filterValue !== null &&
              filterValue !== '' &&
              !excludedParams.includes(searchableField.field)
            ) {
              if (searchableField.resolver) {
                searchableField.resolver(
                  query,
                  config.tableAlias,
                  searchableField.field,
                  filterValue,
                );
              } else {
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

        result = await paginate(query, { page, limit });
      }

      // Limit array relations to 50 items if includes were used
      if (includes && this.configRegistry) {
        const includesTree = parseIncludesToTree(includes);
        limitArrayRelations(
          result.items,
          config,
          this.configRegistry,
          includesTree,
        );
      }

      // Calculate query duration
      const _queryDurationMs = Date.now() - _queryStartTime;

      return {
        items: result.items,
        metaInfo: result.meta,
        _status: HttpStatus.OK,
        _queryDate,
        _queryDurationMs,
      };
    }

    @findOneDecoratorsCombined
    @Get(`:${config.primaryKey}`)
    async findOne(
      @Param(config.primaryKey) id: string,
      @Query('includes') includes?: string,
    ) {
      // Performance monitoring
      const _queryStartTime = Date.now();
      const _queryDate = new Date().toISOString();

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
        limitArrayRelations(
          [entity],
          config,
          this.configRegistry,
          includesTree,
        );
      }

      // Calculate query duration
      const _queryDurationMs = Date.now() - _queryStartTime;

      return {
        ...entity,
        _status: HttpStatus.OK,
        _queryDate,
        _queryDurationMs,
      };
    }
  }

  return BaseController;
}
