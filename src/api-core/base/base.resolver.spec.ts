import { BadRequestException } from '@nestjs/common';
import { createBaseResolver } from './base.resolver';
import { EntityConfig } from '../types/entity-config.interface';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn().mockResolvedValue({
    items: [],
    meta: { itemCount: 0, totalItems: 0, itemsPerPage: 100, totalPages: 0, currentPage: 1 },
  }),
}));

class FakeEntity {
  id: string;
}

function makeConfig(
  overrides: Partial<EntityConfig<FakeEntity>> = {},
): EntityConfig<FakeEntity> {
  return {
    entity: FakeEntity,
    primaryKey: 'id',
    defaultOrderBy: 'id',
    tableAlias: 'fake_entity',
    routePrefix: 'fake-entities',
    queryNames: { plural: 'fakeEntities', singular: 'fakeEntity' },
    swaggerTag: 'Fake',
    ...overrides,
  };
}

function makeRepository() {
  const queryBuilder = {
    orderBy: jest.fn().mockReturnThis(),
  };
  return {
    createQueryBuilder: jest.fn(() => queryBuilder),
  };
}

describe('createBaseResolver maxPage', () => {
  it('rejects page 501 for the default cap (no per-entity maxPage set)', async () => {
    const Resolver = createBaseResolver(makeConfig());
    const resolver = new Resolver(makeRepository() as any);

    await expect(resolver.findAll(501, 100)).rejects.toThrow(
      'Maximum page is 500',
    );
  });

  it('accepts a page beyond 500 when the entity config raises maxPage', async () => {
    const Resolver = createBaseResolver(makeConfig({ maxPage: 1_000_000 }));
    const resolver = new Resolver(makeRepository() as any);

    await expect(resolver.findAll(501, 100)).resolves.toBeDefined();
  });

  it('still rejects a page beyond the raised cap', async () => {
    const Resolver = createBaseResolver(makeConfig({ maxPage: 1_000_000 }));
    const resolver = new Resolver(makeRepository() as any);

    await expect(resolver.findAll(1_000_001, 100)).rejects.toThrow(
      new BadRequestException('Maximum page is 1000000'),
    );
  });
});
