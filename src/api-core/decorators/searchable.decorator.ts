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

export interface SearchableOptions {
  resolver?: SearchResolver;
  description?: string;
}

/**
 * Decorator to mark an entity column as searchable/filterable.
 * 
 * @param options Optional resolver function or options object with resolver and description.
 *                If resolver is provided, it will be used for custom filtering logic.
 *                If not provided, default behavior is exact match (WHERE field = value).
 * 
 * @example
 * // Default exact match
 * @Searchable()
 * hash: string;
 * 
 * @example
 * // With description
 * @Searchable({ description: 'Filter by transaction hash' })
 * hash: string;
 * 
 * @example
 * // Custom resolver for prefix matching
 * @Searchable((qb, alias, field, value) => {
 *   qb.andWhere(`${alias}.${field} LIKE :${field}`, { [field]: `${value}%` });
 * })
 * hash: string;
 * 
 * @example
 * // Custom resolver with description
 * @Searchable({
 *   resolver: (qb, alias, field, value) => {
 *     qb.andWhere(`${alias}.${field} LIKE :${field}`, { [field]: `${value}%` });
 *   },
 *   description: 'Filter by hash prefix'
 * })
 * hash: string;
 */
export const Searchable = (options?: SearchResolver | SearchableOptions): PropertyDecorator => {
  // Support both @Searchable(resolver) and @Searchable({ resolver, description })
  let resolver: SearchResolver | undefined;
  let description: string | undefined;
  
  if (typeof options === 'function') {
    resolver = options;
  } else if (options) {
    resolver = options.resolver;
    description = options.description;
  }
  
  return (target: any, propertyKey: string | symbol) => {
    // Store metadata on the property (include resolver and description)
    Reflect.defineMetadata(SEARCHABLE_METADATA_KEY, { resolver: resolver || null, description }, target, propertyKey);
    
    // Also store the field name, resolver, and description in a class-level map for easy retrieval
    const existingFields = Reflect.getMetadata(SEARCHABLE_FIELDS_KEY, target) || new Map();
    existingFields.set(propertyKey, { resolver: resolver || null, description });
    Reflect.defineMetadata(SEARCHABLE_FIELDS_KEY, existingFields, target);
  };
};

