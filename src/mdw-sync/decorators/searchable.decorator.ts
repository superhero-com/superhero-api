import 'reflect-metadata';
import { SelectQueryBuilder } from 'typeorm';

export const SEARCHABLE_METADATA_KEY = 'searchable';
export const SEARCHABLE_FIELDS_KEY = 'searchable_fields';

/**
 * Type for custom search resolver function.
 * If provided, this function will be used to apply custom filtering logic.
 * If not provided, default behavior is exact match (WHERE field = value).
 */
export type SearchResolver = (
  queryBuilder: SelectQueryBuilder<any>,
  tableAlias: string,
  fieldName: string,
  searchValue: any,
) => void;

/**
 * Decorator to mark an entity column as searchable/filterable.
 * 
 * @param resolver Optional custom resolver function for custom filtering logic.
 *                 If not provided, default behavior is exact match (WHERE field = value).
 * 
 * @example
 * // Default exact match
 * @Searchable()
 * hash: string;
 * 
 * @example
 * // Custom resolver for prefix matching
 * @Searchable((qb, alias, field, value) => {
 *   qb.andWhere(`${alias}.${field} LIKE :${field}`, { [field]: `${value}%` });
 * })
 * hash: string;
 */
export const Searchable = (resolver?: SearchResolver): PropertyDecorator => {
  return (target: any, propertyKey: string | symbol) => {
    // Store metadata on the property
    Reflect.defineMetadata(SEARCHABLE_METADATA_KEY, resolver || null, target, propertyKey);
    
    // Also store the field name and resolver in a class-level map for easy retrieval
    const existingFields = Reflect.getMetadata(SEARCHABLE_FIELDS_KEY, target) || new Map();
    existingFields.set(propertyKey, resolver || null);
    Reflect.defineMetadata(SEARCHABLE_FIELDS_KEY, existingFields, target);
  };
};

