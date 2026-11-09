import {
  BadRequestException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { ENTITY_CONFIGS } from '@/mdw-sync/config/entity-configs';
import {
  GENERATION_CONFIG,
  INCLUDE_GRAPH_CONFIGS,
} from '@/test/harness/include-graph';
import { createBaseController } from './base.controller';
import { EntityConfig } from '../types/entity-config.interface';
import { parseIncludesToTree } from '../utils/includes-parser';
import {
  createEntityConfigRegistry,
  validateIncludesTree,
} from '../utils/relation-loader';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn().mockResolvedValue({
    items: [],
    meta: {
      itemCount: 0,
      totalItems: 0,
      itemsPerPage: 100,
      totalPages: 0,
      currentPage: 1,
    },
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
    const Controller = createBaseController(makeConfig({ maxPage: 1_000_000 }));
    const controller = new Controller(makeRepository() as any);

    await expect(
      controller.listAll(501, 100, undefined, 'DESC', undefined, {}),
    ).resolves.toBeDefined();
  });

  it('still rejects a page beyond the raised cap', async () => {
    const Controller = createBaseController(makeConfig({ maxPage: 1_000_000 }));
    const controller = new Controller(makeRepository() as any);

    await expect(
      controller.listAll(1_000_001, 100, undefined, 'DESC', undefined, {}),
    ).rejects.toThrow('Maximum page is 1000000');
  });
});

describe('createBaseController includes docs', () => {
  const documentedIncludes: Record<string, string> = {
    'v2/mdw/txs': 'keyBlock',
    'v2/mdw/key-blocks': 'txs',
    generations: 'items, blocks, blocks.items',
    blocks: 'generation, generation.items, items, items.generation',
    items: 'generation, generation.blocks',
  };

  const configs = [...ENTITY_CONFIGS, ...INCLUDE_GRAPH_CONFIGS];

  it.each(configs.filter((config) => config.relations?.length))(
    'documents only includes that pass validation for $routePrefix',
    (config) => {
      const registry = createEntityConfigRegistry(configs);
      const Controller = createBaseController(config as any, registry);
      // @nestjs/swagger keeps DECORATORS.API_PARAMETERS out of its exports map.
      const { description } = Reflect.getMetadata(
        'swagger/apiParameters',
        Controller.prototype.listAll,
      ).find((param: any) => param.name === 'includes');
      const [, available, example] = description.match(
        /Available: (.*?)(?:\. Example: "(.*)")?$/,
      );

      expect(available).toBe(documentedIncludes[config.routePrefix]);
      for (const includes of [...available.split(', '), example ?? '']) {
        expect(() =>
          validateIncludesTree(
            config as any,
            parseIncludesToTree(includes),
            registry,
          ),
        ).not.toThrow();
      }
    },
  );
});

describe('createBaseController includes (HTTP)', () => {
  let app: INestApplication;
  const repository = makeRepository();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        createBaseController(
          GENERATION_CONFIG,
          createEntityConfigRegistry(INCLUDE_GRAPH_CONFIGS),
        ),
      ],
      providers: [
        {
          provide: getRepositoryToken(GENERATION_CONFIG.entity),
          useValue: repository,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Same options as main.ts, which join a repeated ?includes= into one string.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(() => jest.clearAllMocks());

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['/generations?includes=items,blocks', 'cannot be combined'],
    ['/generations?includes=items&includes=blocks', 'cannot be combined'],
    [
      '/generations?includes=items.generation.items',
      'leads back to Generation',
    ],
    ['/generations/g_1?includes=blocks.generation', 'leads back to Generation'],
  ])('answers %s with 400 before querying', async (url, message) => {
    const response = await request(app.getHttpServer()).get(url).expect(400);

    expect(response.body.message).toContain(message);
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it.each([
    '/generations?includes=blocks,blocks.items',
    '/generations?includes=unknown.nested',
  ])('serves %s', async (url) => {
    await request(app.getHttpServer()).get(url).expect(200);

    expect(repository.createQueryBuilder).toHaveBeenCalled();
  });
});
