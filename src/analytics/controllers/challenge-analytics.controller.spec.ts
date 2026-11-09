import {
  BadRequestException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { BclPnlService } from '@/account/services/bcl-pnl.service';
import { Post } from '@/social/entities/post.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { ChallengeAnalyticsService } from '../services/challenge-analytics.service';
import { ChallengeAnalyticsController } from './challenge-analytics.controller';

const ADDRESS = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';

describe('ChallengeAnalyticsController', () => {
  let controller: ChallengeAnalyticsController;
  let challengeAnalyticsService: { getChallengeAnalytics: jest.Mock };

  beforeEach(() => {
    challengeAnalyticsService = {
      getChallengeAnalytics: jest.fn().mockResolvedValue([]),
    };
    controller = new ChallengeAnalyticsController(
      challengeAnalyticsService as any,
    );
  });

  it.each([
    ['0001-01-01', '9999-12-31'],
    ['2024-01-01', '2025-01-01'],
    ['not-a-date', '2026-01-01'],
    ['2026-01-01', 'not-a-date'],
    ['2026-02-01', '2026-01-01'],
  ])('rejects %s..%s without querying', async (start, end) => {
    await expect(
      controller.getChallengeAnalytics(ADDRESS, start, end),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      challengeAnalyticsService.getChallengeAnalytics,
    ).not.toHaveBeenCalled();
  });
});

describe('ChallengeAnalyticsController (HTTP)', () => {
  let app: INestApplication;
  const get = (query: string) =>
    request(app.getHttpServer()).get(
      `/analytics/challenge?addresses=${ADDRESS}${query}`,
    );

  beforeAll(async () => {
    const repository = { query: jest.fn().mockResolvedValue([]) };
    const module = await Test.createTestingModule({
      controllers: [ChallengeAnalyticsController],
      providers: [
        ChallengeAnalyticsService,
        { provide: getRepositoryToken(Transaction), useValue: repository },
        { provide: getRepositoryToken(Post), useValue: repository },
        {
          provide: BclPnlService,
          useValue: {
            calculateDailyPnlBatch: jest.fn().mockResolvedValue(new Map()),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    // Same pipe as main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(() => app.close());

  it('answers 400 for a 0001..9999 range', () =>
    get('&start_date=0001-01-01&end_date=9999-12-31').expect(400));

  it('returns one row per day for a 366-day range', async () => {
    const { body } = await get(
      '&start_date=2024-01-01&end_date=2024-12-31',
    ).expect(200);

    expect(body).toHaveLength(366);
  });

  it('defaults to the last 15 days, today included', async () => {
    const { body } = await get('').expect(200);

    expect(body).toHaveLength(15);
  });
});
