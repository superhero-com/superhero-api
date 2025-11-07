import 'reflect-metadata';

export const SORTABLE_METADATA_KEY = 'sortable';
export const SORTABLE_FIELDS_KEY = 'sortable_fields';

/**
 * Decorator to mark an entity column as sortable.
 * Fields marked with this decorator can be used for ordering in queries.
 */
export const Sortable = (): PropertyDecorator => {
  return (target: any, propertyKey: string | symbol) => {
    // Store metadata on the property
    Reflect.defineMetadata(SORTABLE_METADATA_KEY, true, target, propertyKey);
    
    // Also store the field name in a class-level array for easy retrieval
    const existingFields = Reflect.getMetadata(SORTABLE_FIELDS_KEY, target) || [];
    if (!existingFields.includes(propertyKey)) {
      existingFields.push(propertyKey);
      Reflect.defineMetadata(SORTABLE_FIELDS_KEY, existingFields, target);
    }
  };
};

