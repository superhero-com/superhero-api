import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Logger } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { paginate } from 'nestjs-typeorm-paginate';
import request from 'supertest';
import { createEntityResolvers } from '@/api-core/factories/entity-factory';
import { ENTITY_CONFIGS } from '@/mdw-sync/config/entity-configs';
import { QUERY_LIMIT_OPTIONS } from './query-limits';
import {
  applyGraphqlRateLimit,
  GRAPHQL_PATH,
  GraphqlRateLimiter,
  MAX_GRAPHQL_REQUESTS_PER_MINUTE as MAX,
} from './rate-limit';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn().mockResolvedValue({
    items: [],
    meta: {
      itemCount: 0,
      totalItems: 0,
      itemsPerPage: 1,
      totalPages: 0,
      currentPage: 1,
    },
  }),
}));

describe('GraphqlRateLimiter', () => {
  const T0 = 1_700_000_000_000;
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  const takeTimes = (
    limiter: GraphqlRateLimiter,
    client: string,
    times: number,
    now = T0,
  ) => Array.from({ length: times }, () => limiter.take(client, now));

  it(`allows ${MAX} requests per client in a minute and refuses the next`, () => {
    const limiter = new GraphqlRateLimiter();

    expect(takeTimes(limiter, 'a', MAX).every(Boolean)).toBe(true);
    expect(limiter.take('a', T0 + 59_999)).toBe(false);
  });

  it('counts each client separately', () => {
    const limiter = new GraphqlRateLimiter();
    takeTimes(limiter, 'a', MAX + 1);

    expect(limiter.take('b', T0)).toBe(true);
  });

  it('starts a fresh window after a minute and logs what it refused', () => {
    const limiter = new GraphqlRateLimiter();
    takeTimes(limiter, 'a', MAX + 2);

    expect(limiter.take('a', T0 + 60_000)).toBe(true);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0][0]).toMatch(/refused 2 requests/);
  });

  it('does not log a window with nothing refused', () => {
    const limiter = new GraphqlRateLimiter();
    takeTimes(limiter, 'a', MAX);
    limiter.take('a', T0 + 60_000);

    expect(errorLog).not.toHaveBeenCalled();
  });

  it.each([
    [100, 60],
    [59_001, 1],
    [59_999, 1],
  ])('at %ims into the window, retries after %is', (elapsed, seconds) => {
    const limiter = new GraphqlRateLimiter();
    limiter.take('a', T0);

    expect(limiter.secondsUntilReset(T0 + elapsed)).toBe(seconds);
  });
});

describe('applyGraphqlRateLimit (HTTP)', () => {
  let app: NestExpressApplication;
  const QUERY = '{ keyBlocks(limit: 1) { items { hash } } }';

  const post = (ip: string) =>
    request(app.getHttpServer())
      .post(GRAPHQL_PATH)
      .set('X-Forwarded-For', ip)
      .send({ query: QUERY });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          path: GRAPHQL_PATH,
          autoSchemaFile: true,
          ...QUERY_LIMIT_OPTIONS,
        }),
      ],
      providers: [
        ...createEntityResolvers(ENTITY_CONFIGS),
        ...ENTITY_CONFIGS.map((config) => ({
          provide: getRepositoryToken(config.entity),
          useValue: {
            createQueryBuilder: jest.fn(() => ({
              orderBy: jest.fn().mockReturnThis(),
            })),
          },
        })),
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    // Each test gets its own client IP, so buckets don't carry over.
    app.set('trust proxy', 'loopback');
    applyGraphqlRateLimit(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it(`serves ${MAX} requests a minute, then refuses before Apollo runs`, async () => {
    for (let i = 0; i < MAX; i++) {
      const response = await post('203.0.113.1').expect(200);
      expect(response.body.errors).toBeUndefined();
    }

    const refused = await post('203.0.113.1').expect(429);

    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(refused.body.errors[0].extensions.code).toBe('RATE_LIMITED');
    expect(paginate).toHaveBeenCalledTimes(MAX);
  });

  it('keeps serving other clients', async () => {
    for (let i = 0; i <= MAX; i++) {
      await post('203.0.113.2');
    }

    await post('203.0.113.3').expect(200);
  });
});
