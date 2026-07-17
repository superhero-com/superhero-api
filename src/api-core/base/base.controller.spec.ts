import { BadRequestException } from '@nestjs/common';
import { createBaseController } from './base.controller';
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
    orderByFields: ['id'],
    ...overrides,
  };
}

function makeRepository() {
  const queryBuilder = {
    createQueryBuilder: undefined as any,
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
  };
  return {
    createQueryBuilder: jest.fn(() => queryBuilder),
  };
}

describe('createBaseController maxPage', () => {
  it('rejects page 501 for the default cap (no per-entity maxPage set)', async () => {
    const Controller = createBaseController(makeConfig());
    const controller = new Controller(makeRepository() as any);

    await expect(
      controller.listAll(501, 100, undefined, 'DESC', undefined, {}),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.listAll(501, 100, undefined, 'DESC', undefined, {}),
    ).rejects.toThrow('Maximum page is 500');
  });

  it('accepts a page beyond 500 when the entity config raises maxPage', async () => {
    const Controller = createBaseController(
      makeConfig({ maxPage: 1_000_000 }),
    );
    const controller = new Controller(makeRepository() as any);

    await expect(
      controller.listAll(501, 100, undefined, 'DESC', undefined, {}),
    ).resolves.toBeDefined();
  });

  it('still rejects a page beyond the raised cap', async () => {
    const Controller = createBaseController(
      makeConfig({ maxPage: 1_000_000 }),
    );
    const controller = new Controller(makeRepository() as any);

    await expect(
      controller.listAll(1_000_001, 100, undefined, 'DESC', undefined, {}),
    ).rejects.toThrow('Maximum page is 1000000');
  });
});
