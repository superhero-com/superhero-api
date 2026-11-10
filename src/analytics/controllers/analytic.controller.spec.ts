import { CACHE_MANAGER, CacheModule } from '@nestjs/cache-manager';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BigNumber } from 'bignumber.js';
import { Cache } from 'cache-manager';
import { Keyv } from 'keyv';
import request from 'supertest';
import { createLruKeyvStore } from '@/utils/lru-keyv-store';
import { Analytic } from '../entities/analytic.entity';
import { CacheDailyAnalyticsDataService } from '../services/cache-daily-analytics-data.service';
import { AnalyticController } from './analytic.controller';

const ADDRESS = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';

describe('AnalyticController (HTTP)', () => {
  let app: INestApplication;
  const cachedRows = [{ date: '2026-01-01' }];
  const analyticRepository = { find: jest.fn().mockResolvedValue(cachedRows) };
  const cacheDailyAnalyticsDataService = {
    pullAnalyticsDataByDateRange: jest.fn(),
    pullAnalyticsData: jest.fn(),
    getDateRangeAnalyticsLive: jest.fn(),
    getDateAnalytics: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CacheModule.register({
          stores: [
            new Keyv({
              store: createLruKeyvStore({ max: 100, maxSize: 1024 * 1024 }),
            }),
          ],
        }),
      ],
      controllers: [AnalyticController],
      providers: [
        { provide: getRepositoryToken(Analytic), useValue: analyticRepository },
        {
          provide: CacheDailyAnalyticsDataService,
          useValue: cacheDailyAnalyticsDataService,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    // Same options as main.ts, so unknown query keys behave as in production.
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

  it('serves cached rows and ignores the removed force_pull flag', async () => {
    const response = await request(app.getHttpServer())
      .get('/analytics')
      .query({
        start_date: '0001-01-01',
        end_date: '9999-12-31',
        force_pull: 'true',
      })
      .expect(200);

    expect(response.body).toEqual(cachedRows);
    expect(
      cacheDailyAnalyticsDataService.pullAnalyticsDataByDateRange,
    ).not.toHaveBeenCalled();
    expect(
      cacheDailyAnalyticsDataService.pullAnalyticsData,
    ).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an address over 367 days',
      { address: ADDRESS, start_date: '2024-01-01', end_date: '2025-01-01' },
    ],
    ['an impossible start_date', { start_date: '2026-02-30' }],
  ])('answers 400 for %s without querying', async (_, query) => {
    await request(app.getHttpServer())
      .get('/analytics')
      .query(query)
      .expect(400);

    expect(
      cacheDailyAnalyticsDataService.getDateRangeAnalyticsLive,
    ).not.toHaveBeenCalled();
    expect(analyticRepository.find).not.toHaveBeenCalled();
  });

  it('serves an address over 366 days live', async () => {
    const liveRows = [{ date: '2024-12-31' }];
    cacheDailyAnalyticsDataService.getDateRangeAnalyticsLive.mockResolvedValueOnce(
      liveRows,
    );

    const response = await request(app.getHttpServer())
      .get('/analytics')
      .query({
        address: ADDRESS,
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      })
      .expect(200);

    expect(response.body).toEqual(liveRows);
  });

  it('leaves the other analytics routes uncached', async () => {
    await request(app.getHttpServer()).get('/analytics').expect(200);
    const second = await request(app.getHttpServer())
      .get('/analytics')
      .expect(200);

    expect(second.headers['x-cache']).toBeUndefined();
    expect(analyticRepository.find).toHaveBeenCalledTimes(2);
  });

  describe('GET /analytics/past-24-hours', () => {
    const ROUTE = '/analytics/past-24-hours';
    const get = (url: string) => request(app.getHttpServer()).get(url);

    beforeEach(async () => {
      cacheDailyAnalyticsDataService.getDateAnalytics.mockImplementation(
        async (_start: Date, _end: Date, address?: string) => ({
          date: '2026-11-08',
          total_market_cap_sum: new BigNumber('123456789012345678901.5'),
          total_volume_sum: new BigNumber('0.000000012'),
          total_tokens: 42,
          scope: address ?? 'global',
        }),
      );
      await app.get<Cache>(CACHE_MANAGER).clear();
    });

    afterEach(() => jest.restoreAllMocks());

    it('serves a repeat request from the cache with the same body', async () => {
      const miss = await get(ROUTE).expect(200);
      const hit = await get(ROUTE).expect(200);

      expect(miss.headers['x-cache']).toBe('MISS');
      expect(hit.headers['x-cache']).toBe('HIT');
      expect(hit.text).toBe(miss.text);
      expect(
        cacheDailyAnalyticsDataService.getDateAnalytics,
      ).toHaveBeenCalledTimes(1);
    });

    it('recomputes after 60 seconds', async () => {
      const now = Date.now();
      await get(ROUTE).expect(200);

      const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 59_000);
      expect((await get(ROUTE)).headers['x-cache']).toBe('HIT');

      clock.mockReturnValue(now + 61_000);
      expect((await get(ROUTE)).headers['x-cache']).toBe('MISS');
    });

    it('caches each address separately', async () => {
      const addressUrl = `${ROUTE}?address=${ADDRESS}`;

      expect((await get(ROUTE)).body.scope).toBe('global');
      expect((await get(addressUrl)).body.scope).toBe(ADDRESS);
      expect((await get(ROUTE)).body.scope).toBe('global');
      expect((await get(addressUrl)).body.scope).toBe(ADDRESS);
      expect(
        cacheDailyAnalyticsDataService.getDateAnalytics,
      ).toHaveBeenCalledTimes(2);
    });

    it('still rejects an invalid address on every request', async () => {
      await get(`${ROUTE}?address=nope`).expect(400);
      await get(`${ROUTE}?address=nope`).expect(400);

      expect(
        cacheDailyAnalyticsDataService.getDateAnalytics,
      ).not.toHaveBeenCalled();
    });

    it('does not cache a failed computation', async () => {
      cacheDailyAnalyticsDataService.getDateAnalytics.mockRejectedValueOnce(
        new Error('db down'),
      );

      await get(ROUTE).expect(500);
      const retry = await get(ROUTE).expect(200);

      expect(retry.headers['x-cache']).toBe('MISS');
    });
  });
});
