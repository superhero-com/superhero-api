import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { Analytic } from '../entities/analytic.entity';
import { CacheDailyAnalyticsDataService } from '../services/cache-daily-analytics-data.service';
import { AnalyticController } from './analytic.controller';

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
});
