/**
 * API Core - Dynamic API Generation System
 *
 * This module provides a reusable system for automatically generating
 * REST API endpoints and GraphQL resolvers from TypeORM entities.
 *
 * @module api-core
 */

// Decorators
export * from './decorators/sortable.decorator';
export * from './decorators/searchable.decorator';

// Types
export * from './types/entity-config.interface';
export * from './types/pagination.type';

// Utilities
export * from './utils/metadata-reader';

// Factories
export * from './factories/entity-factory';

// Base classes (for extension)
export { createBaseController } from './base/base.controller';
export { createBaseResolver } from './base/base.resolver';
