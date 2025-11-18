import { Type } from '@nestjs/common';
import { SelectQueryBuilder } from 'typeorm';
import { EntityConfig, RelationConfig } from '../types/entity-config.interface';
import { IncludesTree } from './includes-parser';

/**
 * Registry to map entity types to their EntityConfig
 */
export type EntityConfigRegistry = Map<Type<any>, EntityConfig<any>>;

/**
 * Creates a registry map from an array of entity configs
 * @param configs - Array of EntityConfig objects
 * @returns Map of entity type to EntityConfig
 */
export function createEntityConfigRegistry(
  configs: EntityConfig<any>[],
): EntityConfigRegistry {
  const registry = new Map<Type<any>, EntityConfig<any>>();
  for (const config of configs) {
    registry.set(config.entity, config);
  }
  return registry;
}

/**
 * Resolves a relation config by field name from an entity config
 * @param entityConfig - The entity config to search
 * @param relationField - The field name of the relation
 * @returns RelationConfig if found, null otherwise
 */
export function resolveRelation(
  entityConfig: EntityConfig,
  relationField: string,
): RelationConfig | null {
  if (!entityConfig.relations) {
    return null;
  }

  return entityConfig.relations.find((r) => r.field === relationField) || null;
}

/**
 * Checks if the includes tree contains any array relations (OneToMany)
 * @param entityConfig - The entity config
 * @param includesTree - The includes tree
 * @param configRegistry - Registry to look up related entity configs
 * @returns true if any array relations are included
 */
export function checkHasArrayRelations(
  entityConfig: EntityConfig,
  includesTree: IncludesTree,
  configRegistry: EntityConfigRegistry,
): boolean {
  for (const [relationField, nestedIncludes] of Object.entries(includesTree)) {
    const relationConfig = resolveRelation(entityConfig, relationField);
    if (relationConfig && relationConfig.isArray) {
      return true;
    }
    
    // Recursively check nested includes
    if (Object.keys(nestedIncludes).length > 0) {
      const relatedEntityConfig = configRegistry.get(relationConfig!.relatedEntity);
      if (relatedEntityConfig && checkHasArrayRelations(relatedEntityConfig, nestedIncludes, configRegistry)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Generates a unique table alias for a relation join
 * @param parentAlias - The parent table alias
 * @param relationField - The relation field name
 * @returns Unique alias string
 */
function generateJoinAlias(parentAlias: string, relationField: string): string {
  // Replace dots with underscores for nested relations
  const sanitized = relationField.replace(/\./g, '_');
  return `${parentAlias}_${sanitized}`;
}

/**
 * Applies includes to a QueryBuilder using leftJoinAndMapOne/leftJoinAndMapMany
 * @param queryBuilder - The TypeORM QueryBuilder to modify
 * @param entityConfig - The entity config for the current entity
 * @param includesTree - The parsed includes tree structure
 * @param configRegistry - Registry to look up related entity configs
 * @param parentAlias - The current table alias (defaults to entityConfig.tableAlias)
 * @param parentPath - The property path for mapping (e.g., "microBlock.txs")
 * @param depth - Current recursion depth (to prevent infinite loops)
 */
export function applyIncludesToQueryBuilder<T>(
  queryBuilder: SelectQueryBuilder<T>,
  entityConfig: EntityConfig<T>,
  includesTree: IncludesTree,
  configRegistry: EntityConfigRegistry,
  parentAlias: string = entityConfig.tableAlias,
  parentPath: string = '',
  depth: number = 0,
  rootAlias?: string,
): void {
  // Prevent infinite recursion (max depth of 10)
  if (depth > 10) {
    return;
  }

  // Store root alias on first call
  if (depth === 0) {
    rootAlias = parentAlias;
  }

  // Process each relation in the includes tree
  for (const [relationField, nestedIncludes] of Object.entries(includesTree)) {
    // Look up the relation config
    const relationConfig = resolveRelation(entityConfig, relationField);

    if (!relationConfig) {
      // Relation not found, skip it (could log warning in production)
      continue;
    }

    // Get the related entity's config
    const relatedEntityConfig = configRegistry.get(relationConfig.relatedEntity);
    if (!relatedEntityConfig) {
      // Related entity config not found, skip
      continue;
    }

    // Generate unique alias for this join
    const joinAlias = generateJoinAlias(parentAlias, relationField);

    // Build join condition from RelationConfig
    // Format: parentAlias.parentField = joinAlias.localField
    const joinCondition = `${parentAlias}.${relationConfig.joinCondition.parentField} = ${joinAlias}.${relationConfig.joinCondition.localField}`;

    // Build the property path for mapping
    // For root level relations, use rootAlias.relationField (e.g., "micro_block.keyBlock")
    // For nested relations, use parentPath.relationField (e.g., "micro_block.txs.block")
    const mapPath = depth === 0 
      ? `${rootAlias}.${relationField}`
      : parentPath 
        ? `${parentPath}.${relationField}` 
        : `${rootAlias}.${relationField}`;

    // Get the related entity's metadata and table name
    const relatedEntityMetadata = queryBuilder.connection.getMetadata(
      relationConfig.relatedEntity,
    );
    const relatedTableName = relatedEntityMetadata.tableName;
    
    // Use leftJoinAndMapOne for single relations, leftJoinAndMapMany for array relations
    // Note: leftJoinAndMapOne/leftJoinAndMapMany can accept either entity class or table name string
    // We use the entity class which should work, but if it doesn't, we can fall back to table name
    if (relationConfig.isArray) {
      // For array relations, we join all items
      // Note: TypeORM doesn't support limit on joined relations directly
      // Limiting will be handled in post-processing in BaseController
      queryBuilder.leftJoinAndMapMany(
        mapPath,
        relationConfig.relatedEntity,
        joinAlias,
        joinCondition,
      );
    } else {
      // Single relation - use leftJoinAndMapOne
      // This automatically selects all columns from the related entity and maps them
      // The entity class should work, but if there are issues, we might need to use table name
      queryBuilder.leftJoinAndMapOne(
        mapPath,
        relationConfig.relatedEntity,
        joinAlias,
        joinCondition,
      );
    }

    // Recursively process nested includes
    if (Object.keys(nestedIncludes).length > 0) {
      applyIncludesToQueryBuilder(
        queryBuilder,
        relatedEntityConfig,
        nestedIncludes,
        configRegistry,
        joinAlias,
        mapPath,
        depth + 1,
        rootAlias,
      );
    }
  }
}

