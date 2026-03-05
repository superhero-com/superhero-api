import 'reflect-metadata';
import {
  Resolver,
  Query,
  Args,
  Int,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { InjectRepository, getRepositoryToken } from '@nestjs/typeorm';
import { Inject, Optional } from '@nestjs/common';
import { Repository } from 'typeorm';
import { paginate } from 'nestjs-typeorm-paginate';
import { PaginatedResponse } from '../types/pagination.type';
import { EntityConfig } from '../types/entity-config.interface';

export function createBaseResolver<T>(config: EntityConfig<T>) {
  const PaginatedResponseType = PaginatedResponse(config.entity);

  // Collect all unique related entity types for repository injection
  const relatedEntityTypes = config.relations
    ? Array.from(new Set(config.relations.map((r) => r.relatedEntity)))
    : [];

  @Resolver(() => config.entity)
  class BaseResolver {
    public readonly repository: Repository<T>;
    public readonly relatedRepositories: Map<Function, Repository<any>>;

    constructor(
      repository: Repository<T>,
      @Optional() repo0?: Repository<any>,
      @Optional() repo1?: Repository<any>,
      @Optional() repo2?: Repository<any>,
      @Optional() repo3?: Repository<any>,
      @Optional() repo4?: Repository<any>,
    ) {
      this.repository = repository;
      this.relatedRepositories = new Map<Function, Repository<any>>();

      // Map related repositories by entity type (only use the ones that exist)
      const repos = [repo0, repo1, repo2, repo3, repo4];
      relatedEntityTypes.forEach((entityType, index) => {
        if (repos[index]) {
          this.relatedRepositories.set(entityType, repos[index]);
        }
      });
    }

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
    async findOne(@Args(config.primaryKey, { type: () => String }) id: string) {
      return this.repository.findOne({
        where: { [config.primaryKey]: id } as any,
      });
    }
  }

  // Apply parameter decorators for repository injection
  InjectRepository(config.entity)(BaseResolver, undefined, 0);

  // Apply @Optional() to all optional repository parameters (1-5) so NestJS knows they're optional
  // This prevents NestJS from trying to resolve them when they don't have @Inject() decorators
  for (let i = 1; i <= 5; i++) {
    Optional()(BaseResolver, undefined, i);
  }

  // Apply @Inject() decorators only for parameters that actually have related entity types
  relatedEntityTypes.forEach((entityType, index) => {
    const paramIndex = index + 1;
    if (paramIndex <= 5) {
      // Only support up to 5 related repositories
      Inject(getRepositoryToken(entityType))(
        BaseResolver,
        undefined,
        paramIndex,
      );
    }
  });

  // Generate ResolveField methods for each relation
  if (config.relations && config.relations.length > 0) {
    config.relations.forEach((relation) => {
      const resolveMethodName = `resolve${relation.field.charAt(0).toUpperCase() + relation.field.slice(1)}`;

      if (relation.isArray) {
        // Array relation (OneToMany) - create resolver function with explicit parameters
        // We need explicit parameters (not rest params) so GraphQL can read metadata
        // Build the function dynamically with explicit parameters for each filterable field

        // Create resolver function with explicit parameters for filterable fields
        // We need explicit parameters (not rest params) so GraphQL can read metadata
        const filterableFields = relation.filterableFields || [];

        // Build parameter mapping for reserved keywords (e.g., 'function' -> 'function_')
        const paramMapping: Record<string, string> = {};
        filterableFields.forEach((f) => {
          // JavaScript reserved keywords that can't be used as parameter names
          const reservedKeywords = [
            'function',
            'class',
            'return',
            'if',
            'else',
            'for',
            'while',
            'var',
            'let',
            'const',
          ];
          if (reservedKeywords.includes(f)) {
            paramMapping[f] = `${f}_`;
          }
        });

        // Build parameter list for the function signature (plain JavaScript, no TypeScript types)
        const paramList = [
          'parent',
          'limit = 100',
          'offset = 0',
          'orderBy',
          'orderDirection',
          ...filterableFields.map((f) => paramMapping[f] || f),
        ].join(', ');

        // Build function body with proper parameter name references
        // Use mapped parameter names for reserved keywords, but keep original field names for DB columns
        // Note: Must use plain JavaScript (no TypeScript syntax like 'as any')
        const functionBody = `
          const repo = this.relatedRepositories.get(relation.relatedEntity);
          if (!repo) {
            throw new Error(\`Repository for \${relation.relatedEntity.name} not found\`);
          }

          const entityName = relation.relatedEntity.name;
          const tableAlias = entityName.charAt(0).toLowerCase() + 
            entityName.slice(1).replace(/([A-Z])/g, '_$1').toLowerCase();
          
          const query = repo.createQueryBuilder(tableAlias);
          
          const parentValue = parent[relation.joinCondition.parentField];
          if (parentValue === undefined || parentValue === null) {
            return [];
          }
          
          query.where(
            \`\${tableAlias}.\${relation.joinCondition.localField} = :parentValue\`,
            { parentValue },
          );

          ${filterableFields
            .map((field) => {
              const paramName = paramMapping[field] || field;
              return `
          if (${paramName} !== undefined && ${paramName} !== null && ${paramName} !== '') {
            query.andWhere(\`\${tableAlias}.${field} = :${field}\`, {
              ${field}: ${paramName},
            });
          }`;
            })
            .join('')}

          if (orderBy) {
            query.orderBy(
              \`\${tableAlias}.\${orderBy}\`,
              orderDirection || relation.defaultOrderDirection || 'DESC',
            );
          } else if (relation.defaultOrderBy) {
            query.orderBy(
              \`\${tableAlias}.\${relation.defaultOrderBy}\`,
              relation.defaultOrderDirection || 'DESC',
            );
          }

          query.limit(limit).offset(offset);
          return query.getMany();
        `;

        // Create function using Function constructor with closure variables passed as parameters
        const resolverImpl = new Function(
          'relation',
          'BaseResolver',
          'T',
          `return async function(${paramList}) {${functionBody}}`,
        )(relation, BaseResolver, config.entity);

        // Assign implementation to prototype first
        (BaseResolver.prototype as any)[resolveMethodName] = resolverImpl;

        // Set parameter type metadata manually so GraphQL can read it
        // This must be set after the function is assigned to the prototype
        const paramTypes: any[] = [
          BaseResolver, // this
          Object, // parent: T (we use Object as a placeholder)
          Number, // limit
          Number, // offset
          String, // orderBy
          String, // orderDirection
          ...filterableFields.map(() => String), // filterable fields
        ];

        // Set metadata on both the prototype method and the function itself
        Reflect.defineMetadata(
          'design:paramtypes',
          paramTypes,
          BaseResolver.prototype,
          resolveMethodName,
        );
        Reflect.defineMetadata('design:paramtypes', paramTypes, resolverImpl);

        // Apply decorators: @ResolveField and @Args for each parameter
        // We need to apply @Parent and @Args decorators to the method parameters
        const descriptor = Object.getOwnPropertyDescriptor(
          BaseResolver.prototype,
          resolveMethodName,
        ) || {
          value: resolverImpl,
          writable: true,
          enumerable: true,
          configurable: true,
        };
        ResolveField(() => relation.returnType(), {
          name: relation.field,
          nullable: relation.nullable || false,
        })(BaseResolver.prototype, resolveMethodName, descriptor);

        // Apply @Parent decorator to first parameter
        Parent()(BaseResolver.prototype, resolveMethodName, 0);

        // Apply @Args decorators for standard parameters
        Args('limit', { type: () => Int, nullable: true, defaultValue: 100 })(
          BaseResolver.prototype,
          resolveMethodName,
          1,
        );
        Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })(
          BaseResolver.prototype,
          resolveMethodName,
          2,
        );
        Args('orderBy', { type: () => String, nullable: true })(
          BaseResolver.prototype,
          resolveMethodName,
          3,
        );
        Args('orderDirection', { type: () => String, nullable: true })(
          BaseResolver.prototype,
          resolveMethodName,
          4,
        );

        // Apply @Args decorators for filterableFields
        if (relation.filterableFields) {
          relation.filterableFields.forEach((field, index) => {
            const paramIndex = 5 + index;
            Args(field, { type: () => String, nullable: true })(
              BaseResolver.prototype,
              resolveMethodName,
              paramIndex,
            );
          });
        }
      } else {
        // Single relation (ManyToOne/OneToOne)
        const resolverImpl = async function (this: BaseResolver, parent: T) {
          const repo = this.relatedRepositories.get(relation.relatedEntity);
          if (!repo) {
            throw new Error(
              `Repository for ${relation.relatedEntity.name} not found`,
            );
          }

          const parentValue = (parent as any)[
            relation.joinCondition.parentField
          ];
          if (parentValue === undefined || parentValue === null) {
            return relation.nullable ? null : undefined;
          }

          return repo.findOne({
            where: { [relation.joinCondition.localField]: parentValue } as any,
          });
        };

        (BaseResolver.prototype as any)[resolveMethodName] = resolverImpl;

        // Apply ResolveField and Parent decorators
        const descriptor = Object.getOwnPropertyDescriptor(
          BaseResolver.prototype,
          resolveMethodName,
        ) || {
          value: resolverImpl,
          writable: true,
          enumerable: true,
          configurable: true,
        };
        ResolveField(() => relation.returnType(), {
          name: relation.field,
          nullable: relation.nullable !== false,
        })(BaseResolver.prototype, resolveMethodName, descriptor);

        Parent()(BaseResolver.prototype, resolveMethodName, 0);
      }
    });
  }

  return BaseResolver;
}
