import { Test, TestingModule } from '@nestjs/testing';
import { HistoricalController } from './historical.controller';
import { TokensService } from '@/tokens/tokens.service';
import { TransactionHistoryService } from '../services/transaction-history.service';
import moment from 'moment';
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
      expect(tokenService.getToken).toHaveBeenCalledWith('test_token');
      expect(tokenHistoryService.getHistoricalData).toHaveBeenCalled();
    });
  });

  describe('getForPreview', () => {
    it('should return preview data', async () => {
      const result = await controller.getForPreview('test_token');
      expect(result).toEqual({ preview: 'data' });
      expect(tokenService.getToken).toHaveBeenCalledWith('test_token');
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
