import 'reflect-metadata';
import { Type } from '@nestjs/common';
import { SORTABLE_METADATA_KEY, SORTABLE_FIELDS_KEY } from '../decorators/sortable.decorator';
import { SEARCHABLE_METADATA_KEY, SEARCHABLE_FIELDS_KEY, SearchResolver } from '../decorators/searchable.decorator';

export interface SearchableField {
  field: string;
  resolver?: SearchResolver;
  description?: string;
}

export interface SortableField {
  field: string;
  description?: string;
}

/**
 * Get all sortable fields from an entity class with their descriptions.
 * Reads @Sortable() decorator metadata from entity properties.
 */
export function getSortableFields(entity: Type<any>): SortableField[] {
  const prototype = entity.prototype;
  
  // First, try to get the map of sortable fields from class-level metadata
  const fieldsMap = Reflect.getMetadata(SORTABLE_FIELDS_KEY, prototype);
  if (fieldsMap && fieldsMap instanceof Map) {
    const sortableFields: SortableField[] = [];
    for (const [field, metadata] of fieldsMap.entries()) {
      const meta = metadata && typeof metadata === 'object' ? metadata : { description: undefined };
      sortableFields.push({
        field: String(field),
        description: meta.description,
      });
    }
    return sortableFields;
  }
  
  // Fallback: try to discover fields by checking metadata on properties
  const sortableFields: SortableField[] = [];
  try {
    const propertyNames = Object.getOwnPropertyNames(prototype);
    for (const propertyName of propertyNames) {
      if (propertyName === 'constructor' || typeof prototype[propertyName] === 'function') {
        continue;
      }
      const metadata = Reflect.getMetadata(SORTABLE_METADATA_KEY, prototype, propertyName);
      if (metadata !== undefined) {
        const meta = metadata && typeof metadata === 'object' ? metadata : { description: undefined };
        sortableFields.push({
          field: propertyName,
          description: meta.description,
        });
      }
    }
  } catch (error) {
    // Ignore errors
  }

  return sortableFields;
}

/**
 * Get all searchable fields from an entity class.
 * Reads @Searchable() decorator metadata from entity properties.
 * Returns array of field names with their optional resolver functions.
 */
export function getSearchableFields(entity: Type<any>): SearchableField[] {
  const prototype = entity.prototype;
  
  // First, try to get the map of searchable fields from class-level metadata
  const fieldsMap = Reflect.getMetadata(SEARCHABLE_FIELDS_KEY, prototype);
  if (fieldsMap && fieldsMap instanceof Map) {
    const searchableFields: SearchableField[] = [];
    for (const [field, metadata] of fieldsMap.entries()) {
      const meta = metadata && typeof metadata === 'object' ? metadata : { resolver: metadata || null, description: undefined };
      searchableFields.push({
        field: String(field),
        resolver: meta.resolver || undefined,
        description: meta.description,
      });
    }
    return searchableFields;
  }
  
  // Fallback: try to discover fields by checking metadata on properties
  const searchableFields: SearchableField[] = [];
  try {
    const propertyNames = Object.getOwnPropertyNames(prototype);
    for (const propertyName of propertyNames) {
      if (propertyName === 'constructor' || typeof prototype[propertyName] === 'function') {
        continue;
      }
      const metadata = Reflect.getMetadata(SEARCHABLE_METADATA_KEY, prototype, propertyName);
      if (metadata !== undefined) {
        const meta = metadata && typeof metadata === 'object' ? metadata : { resolver: metadata || null, description: undefined };
        searchableFields.push({
          field: propertyName,
          resolver: meta.resolver || undefined,
          description: meta.description,
        });
      }
    }
  } catch (error) {
    // Ignore errors
  }

  return searchableFields;
}

