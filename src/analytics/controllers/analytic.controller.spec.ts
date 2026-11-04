import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
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
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AnalyticController],
      providers: [
        { provide: getRepositoryToken(Analytic), useValue: analyticRepository },
        {
          provide: CacheDailyAnalyticsDataService,
          useValue: cacheDailyAnalyticsDataService,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
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
});
