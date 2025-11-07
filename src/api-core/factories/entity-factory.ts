import { Type } from '@nestjs/common';
import { createBaseController } from '../base/base.controller';
import { createBaseResolver } from '../base/base.resolver';
import { EntityConfig } from '../types/entity-config.interface';

export function createEntityController<T>(config: EntityConfig<T>) {
  return createBaseController(config);
}

export function createEntityResolver<T>(config: EntityConfig<T>) {
  return createBaseResolver(config);
}

export function createEntityControllers<T extends EntityConfig<any>>(
  configs: T[],
): Type<any>[] {
  return configs.map((config) => createEntityController(config));
}

export function createEntityResolvers<T extends EntityConfig<any>>(
  configs: T[],
): Type<any>[] {
  return configs.map((config) => createEntityResolver(config));
}

