import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { INestApplication } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getIntrospectionQuery } from 'graphql';
import request from 'supertest';
import { createEntityResolvers } from '@/api-core/factories/entity-factory';
import { ENTITY_CONFIGS } from '@/mdw-sync/config/entity-configs';
import { MAX_QUERY_TOKENS, QUERY_LIMIT_OPTIONS } from './query-limits';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn().mockResolvedValue({
    items: [{ hash: 'kh_1', height: 1 }],
    meta: {
      itemCount: 1,
      totalItems: 1,
      itemsPerPage: 100,
      totalPages: 1,
      currentPage: 1,
    },
  }),
}));

function makeRepository() {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of ['where', 'andWhere', 'orderBy', 'limit', 'offset']) {
    queryBuilder[method] = jest.fn(() => queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue([]);
  return {
    createQueryBuilder: jest.fn(() => queryBuilder),
    findOne: jest.fn().mockResolvedValue(null),
  };
}

// keyBlocks { txs } at full page size: 1,000 + 100 * (1 + 100) = 11,100.
const ONE_NESTED_LIST = 'keyBlocks { items { hash txs { hash } } }';
// Adds a keyBlock lookup per tx: 1,000 + 100 * (1 + 100 * 2) = 21,100.
const LOOKUP_PER_NESTED_ROW =
  'keyBlocks { items { txs { keyBlock { hash } } } }';
// Each costs 1,000 + 1 * (1 + 0) = 1,001, so 14 fit and 15 do not.
const rootLists = (count: number) =>
  `{ ${Array.from({ length: count }, (_, i) => `t${i}: txs(limit: 1) { __typename }`).join(' ')} }`;

describe('GraphQL query limits (HTTP)', () => {
  let app: INestApplication;
  const repositories = ENTITY_CONFIGS.map((config) => ({
    provide: getRepositoryToken(config.entity),
    useValue: makeRepository(),
  }));
  const anyRepositoryQueried = () =>
    repositories.some(
      ({ useValue }) =>
        useValue.createQueryBuilder.mock.calls.length > 0 ||
        useValue.findOne.mock.calls.length > 0,
    );

  const post = (query: string, variables?: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/graphql').send({ query, variables });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          autoSchemaFile: true,
          ...QUERY_LIMIT_OPTIONS,
        }),
      ],
      providers: [...createEntityResolvers(ENTITY_CONFIGS), ...repositories],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs one nested list at full page size', async () => {
    const response = await post(`{ ${ONE_NESTED_LIST} }`).expect(200);

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.keyBlocks.items).toEqual([
      { hash: 'kh_1', txs: [] },
    ]);
  });

  it('runs 14 root lists', async () => {
    const response = await post(rootLists(14)).expect(200);

    expect(response.body.errors).toBeUndefined();
  });

  it.each([
    ['a lookup per nested row', `{ ${LOOKUP_PER_NESTED_ROW} }`],
    ['aliases', `{ a: ${ONE_NESTED_LIST} b: ${ONE_NESTED_LIST} }`],
    ['15 root lists', rootLists(15)],
    [
      'a negative limit',
      // Unclamped, b would bring the total down to 12,000, under the cap.
      `{ a: ${LOOKUP_PER_NESTED_ROW} b: keyBlocks(limit: -100) { items { txs { hash } } } }`,
    ],
  ])('rejects %s before resolving anything', async (_, query) => {
    const response = await post(query).expect(400);

    expect(response.body.errors[0].message).toMatch(/complexity/);
    expect(anyRepositoryQueried()).toBe(false);
  });

  it('reads list limits from variables', async () => {
    const query = `query ($limit: Int) {
      keyBlocks(limit: $limit) { items { txs(limit: $limit) { keyBlock { txs(limit: $limit) { hash } } } } }
    }`;

    const response = await post(query, { limit: 5 }).expect(200);
    expect(response.body.errors).toBeUndefined();
    await post(query, { limit: 100 }).expect(400);
  });

  it('rejects a fragment spread twice per level without walking every copy', async () => {
    let query = '{ keyBlock(hash: "kh_1") { ...F0 } }';
    for (let i = 0; i < 40; i++) {
      query += ` fragment F${i} on KeyBlock { ...F${i + 1} ...F${i + 1} }`;
    }
    query += ' fragment F40 on KeyBlock { hash }';

    const response = await post(query).expect(400);
    expect(response.body.errors[0].message).toMatch(
      /maximum allowed number of nodes/,
    );
    expect(anyRepositoryQueried()).toBe(false);
  });

  it('rejects documents above the token limit', async () => {
    const query = `{ ${'__typename '.repeat(MAX_QUERY_TOKENS)} }`;

    const response = await post(query).expect(400);
    expect(response.body.errors[0].message).toMatch(/tokens/);
  });

  it('still serves the introspection query', async () => {
    const response = await post(getIntrospectionQuery()).expect(200);

    expect(response.body.data.__schema.queryType.name).toBe('Query');
  });
});
