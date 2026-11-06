import {
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HistoricalController } from './historical.controller';
import { Token } from '@/tokens/entities/token.entity';
import { TokensService } from '@/tokens/tokens.service';
import { TransactionHistoryService } from '../services/transaction-history.service';
import { Transaction } from '../entities/transaction.entity';
import moment from 'moment';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Reflector } from '@nestjs/core';

describe('HistoricalController', () => {
  let controller: HistoricalController;
  let tokenService: TokensService;
  let tokenHistoryService: TransactionHistoryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HistoricalController],
      providers: [
        {
          provide: TokensService,
          useValue: {
            getToken: jest
              .fn()
              .mockResolvedValue({ id: 1, address: 'test_token' }),
          },
        },
        {
          provide: TransactionHistoryService,
          useValue: {
            getHistoricalData: jest.fn().mockResolvedValue([{ price: 10 }]),
            getPaginatedHistoricalData: jest
              .fn()
              .mockResolvedValue({ items: [] }),
            getForPreview: jest.fn().mockResolvedValue({ preview: 'data' }),
          },
        },
        {
          provide: CACHE_MANAGER,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
          },
        },
        {
          provide: Reflector,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<HistoricalController>(HistoricalController);
    tokenService = module.get<TokensService>(TokensService);
    tokenHistoryService = module.get<TransactionHistoryService>(
      TransactionHistoryService,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findByAddress', () => {
    it('should return historical data', async () => {
      const result = await controller.findByAddress('test_token');
      expect(result).toEqual([{ price: 10 }]);
      expect(tokenService.getToken).toHaveBeenCalledWith('test_token', true);
      expect(tokenHistoryService.getHistoricalData).toHaveBeenCalled();
    });

    it('should throw NotFoundException when the token does not resolve', async () => {
      jest.spyOn(tokenService, 'getToken').mockResolvedValueOnce(null);
      await expect(controller.findByAddress('missing_token')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getPaginatedHistory', () => {
    it('should throw NotFoundException when the token does not resolve', async () => {
      jest.spyOn(tokenService, 'getToken').mockResolvedValueOnce(null);
      await expect(
        controller.getPaginatedHistory('missing_token'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getForPreview', () => {
    it('should return preview data', async () => {
      const result = await controller.getForPreview('test_token');
      expect(result).toEqual({ preview: 'data' });
      expect(tokenService.getToken).toHaveBeenCalledWith('test_token', true);
      expect(tokenHistoryService.getForPreview).toHaveBeenCalled();
    });
  });

  describe('parseDate', () => {
    it('should parse timestamp correctly', () => {
      const date = controller['parseDate'](1700000000);
      expect(moment.isMoment(date)).toBeTruthy();
    });

    it('should parse string date correctly', () => {
      const date = controller['parseDate']('2023-01-01');
      expect(moment.isMoment(date)).toBeTruthy();
    });
  });
});

describe('HistoricalController (HTTP)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
    };
    const module = await Test.createTestingModule({
      controllers: [HistoricalController],
      providers: [
        TransactionHistoryService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: { createQueryBuilder: () => queryBuilder },
        },
        { provide: getRepositoryToken(Token), useValue: {} },
        { provide: DataSource, useValue: {} },
        {
          provide: TokensService,
          useValue: {
            getToken: jest
              .fn()
              .mockResolvedValue({ sale_address: 'ct_sale', symbol: 'TKN' }),
          },
        },
        {
          provide: CACHE_MANAGER,
          useValue: { get: jest.fn(), set: jest.fn() },
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

  it.each([
    ['an unparseable start_date', 'start_date=garbage'],
    ['one-second candles since 2000', 'interval=1&start_date=2000-01-01'],
  ])('answers 400 for %s', (_, query) =>
    request(app.getHttpServer())
      .get(`/tokens/TKN/transactions?${query}`)
      .expect(400),
  );

  it('serves 1-minute candles over the default 2-day window', () =>
    request(app.getHttpServer())
      .get('/tokens/TKN/transactions?interval=60')
      .expect(200, []));
});
