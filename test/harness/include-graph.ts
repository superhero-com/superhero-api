import { Type } from '@nestjs/common';
import {
  EntityConfig,
  RelationConfig,
} from '@/api-core/types/entity-config.interface';

// The include safeguards only bite when an entity has two array relations,
// which no generated mdw entity has any more. This graph keeps that shape
// (generation -> items + blocks, block -> items) for their tests.
export class Generation {
  hash: string;
  height: number;
}

export class Block {
  hash: string;
  generation_hash: string;
}

export class Item {
  hash: string;
  block_hash: string;
  height: number;
}

function relation(
  field: string,
  relatedEntity: Type<any>,
  isArray: boolean,
  localField: string,
  parentField: string,
): RelationConfig {
  return {
    field,
    relatedEntity,
    returnType: () => (isArray ? [relatedEntity] : relatedEntity),
    joinCondition: { localField, parentField },
    isArray,
    nullable: !isArray,
  };
}

function config(
  entity: Type<any>,
  tableAlias: string,
  relations: RelationConfig[],
): EntityConfig {
  return {
    entity,
    primaryKey: 'hash',
    defaultOrderBy: 'hash',
    tableAlias,
    routePrefix: `${tableAlias}s`,
    queryNames: { plural: `${tableAlias}s`, singular: tableAlias },
    swaggerTag: tableAlias,
    orderByFields: ['hash'],
    relations,
  };
}

export const GENERATION_CONFIG = config(Generation, 'generation', [
  relation('items', Item, true, 'height', 'height'),
  relation('blocks', Block, true, 'generation_hash', 'hash'),
]);

export const BLOCK_CONFIG = config(Block, 'block', [
  relation('generation', Generation, false, 'hash', 'generation_hash'),
  relation('items', Item, true, 'block_hash', 'hash'),
]);

export const ITEM_CONFIG = config(Item, 'item', [
  relation('generation', Generation, false, 'height', 'height'),
]);

export const INCLUDE_GRAPH_CONFIGS = [
  GENERATION_CONFIG,
  BLOCK_CONFIG,
  ITEM_CONFIG,
];
