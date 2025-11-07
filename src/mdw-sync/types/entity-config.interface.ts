import { Type } from '@nestjs/common';
import { ResolveField } from '@nestjs/graphql';

export interface CustomResolveFieldConfig<TEntity = any> {
  field: string;
  resolver: (
    parent: TEntity,
    ...args: any[]
  ) => Promise<any> | any;
  returnType: () => any;
  args?: any[];
}

export interface EntityConfig<TEntity = any> {
  entity: Type<TEntity>;
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
}

