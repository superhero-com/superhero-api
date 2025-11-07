import 'reflect-metadata';
import { Type } from '@nestjs/common';
import { SORTABLE_METADATA_KEY, SORTABLE_FIELDS_KEY } from '../decorators/sortable.decorator';
import { SEARCHABLE_METADATA_KEY, SEARCHABLE_FIELDS_KEY, SearchResolver } from '../decorators/searchable.decorator';

export interface SearchableField {
  field: string;
  resolver?: SearchResolver;
}

/**
 * Get all sortable fields from an entity class.
 * Reads @Sortable() decorator metadata from entity properties.
 */
export function getSortableFields(entity: Type<any>): string[] {
  const prototype = entity.prototype;
  
  // First, try to get the list of sortable fields from class-level metadata
  const fieldsList = Reflect.getMetadata(SORTABLE_FIELDS_KEY, prototype);
  if (fieldsList && Array.isArray(fieldsList)) {
    return fieldsList.map(f => String(f));
  }
  
  // Fallback: try to discover fields by checking metadata on properties
  const sortableFields: string[] = [];
  try {
    const propertyNames = Object.getOwnPropertyNames(prototype);
    for (const propertyName of propertyNames) {
      if (propertyName === 'constructor' || typeof prototype[propertyName] === 'function') {
        continue;
      }
      const metadata = Reflect.getMetadata(SORTABLE_METADATA_KEY, prototype, propertyName);
      if (metadata !== undefined) {
        sortableFields.push(propertyName);
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
    for (const [field, resolver] of fieldsMap.entries()) {
      searchableFields.push({
        field: String(field),
        resolver: resolver || undefined,
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
        searchableFields.push({
          field: propertyName,
          resolver: metadata || undefined,
        });
      }
    }
  } catch (error) {
    // Ignore errors
  }

  return searchableFields;
}

