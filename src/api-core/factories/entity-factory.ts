import { Type } from '@nestjs/common';
import { createBaseController } from '../base/base.controller';
import { createBaseResolver } from '../base/base.resolver';
import { EntityConfig } from '../types/entity-config.interface';
import {
  createEntityConfigRegistry,
  EntityConfigRegistry,
} from '../utils/relation-loader';

export function createEntityController<T>(
  config: EntityConfig<T>,
  configRegistry?: EntityConfigRegistry,
) {
  return createBaseController(config, configRegistry);
}

export function createEntityResolver<T>(config: EntityConfig<T>) {
  return createBaseResolver(config);
}

export function createEntityControllers<T extends EntityConfig<any>>(
  configs: T[],
): Type<any>[] {
  // Create registry from all configs
  const configRegistry = createEntityConfigRegistry(configs);

  // Create controllers with the registry
  return configs.map((config) =>
    createEntityController(config, configRegistry),
  );
}

export function createEntityResolvers<T extends EntityConfig<any>>(
  configs: T[],
): Type<any>[] {
  return configs.map((config) => createEntityResolver(config));
}
