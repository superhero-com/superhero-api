import 'reflect-metadata';

export const SORTABLE_METADATA_KEY = 'sortable';
export const SORTABLE_FIELDS_KEY = 'sortable_fields';

export interface SortableOptions {
  description?: string;
}

/**
 * Decorator to mark an entity column as sortable.
 * Fields marked with this decorator can be used for ordering in queries.
 *
 * @param options Optional configuration object with description
 *
 * @example
 * // Basic usage
 * @Sortable()
 * hash: string;
 *
 * @example
 * // With description
 * @Sortable({ description: 'Transaction hash identifier' })
 * hash: string;
 */
export const Sortable = (
  options?: SortableOptions | string,
): PropertyDecorator => {
  // Support both @Sortable('description') and @Sortable({ description: '...' })
  const description =
    typeof options === 'string' ? options : options?.description;

  return (target: any, propertyKey: string | symbol) => {
    // Store metadata on the property (include description)
    Reflect.defineMetadata(
      SORTABLE_METADATA_KEY,
      { description },
      target,
      propertyKey,
    );

    // Also store the field name and description in a class-level map for easy retrieval
    const existingFields =
      Reflect.getMetadata(SORTABLE_FIELDS_KEY, target) || new Map();
    existingFields.set(propertyKey, { description });
    Reflect.defineMetadata(SORTABLE_FIELDS_KEY, existingFields, target);
  };
};
