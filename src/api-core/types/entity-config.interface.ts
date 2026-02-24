import { Type } from '@nestjs/common';

export interface CustomResolveFieldConfig<TEntity = any> {
  field: string;
  resolver: (parent: TEntity, ...args: any[]) => Promise<any> | any;
  returnType: () => any;
  args?: any[];
}

export interface RelationConfig {
  field: string; // GraphQL field name (e.g., 'txs', 'keyBlock')
  relatedEntity: Type<any>; // Related entity class
  returnType: () => any; // GraphQL return type function
  joinCondition: {
    // Join condition specification
    localField: string; // Field on related entity (e.g., 'block_height')
    parentField: string; // Field on parent entity (e.g., 'height')
  };
  isArray?: boolean; // true for OneToMany, false/undefined for ManyToOne/OneToOne
  nullable?: boolean; // Whether the relation can be null
  filterableFields?: string[]; // Fields from related entity that can be used for filtering
  defaultOrderBy?: string; // Default sort field for collection relations
  defaultOrderDirection?: 'ASC' | 'DESC';
  supportsPagination?: boolean; // Whether to support limit/offset (default: true for arrays)
}

export interface EntityConfig<TEntity = any> {
  entity: Type<TEntity>;
  dto?: Type<any>; // Optional: DTO class for API responses. If not provided, entity will be used
  primaryKey: string;
  defaultOrderBy: string;
  defaultOrderDirection?: 'ASC' | 'DESC';
  tableAlias: string;
  routePrefix: string;
  queryNames: {
    plural: string;
    singular: string;
  };
  swaggerTag: string;
  orderByFields?: string[]; // Optional: specify allowed order_by fields for Swagger. If not provided, will be extracted from entity metadata
  customResolveFields?: CustomResolveFieldConfig<TEntity>[];
  relations?: RelationConfig[]; // Array of relation configurations
}
