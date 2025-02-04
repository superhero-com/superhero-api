/* eslint-disable @typescript-eslint/no-unused-vars */
import { Transaction } from '@/transactions/entities/transaction.entity';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import moment from 'moment';
import { Repository } from 'typeorm';
import { TokensService } from '../../tokens/tokens.service';
import { TokenPerformanceController } from './token-performance.controller';

describe('TokenPerformanceController', () => {
  let controller: TokenPerformanceController;
  let transactionsRepository: Repository<Transaction>;
  let tokensService: TokensService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TokenPerformanceController],
      providers: [
        {
          provide: getRepositoryToken(Transaction),
          useClass: Repository,
        },
        {
          provide: TokensService,
          useValue: {
            getToken: jest.fn().mockResolvedValue({
              id: 1,
              address: 'test_token',
              created_at: moment().subtract(100, 'days').toDate(),
              price_data: { ae: 100 },
            }),
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

    controller = module.get<TokenPerformanceController>(
      TokenPerformanceController,
    );
    transactionsRepository = module.get<Repository<Transaction>>(
      getRepositoryToken(Transaction),
    );
    tokensService = module.get<TokensService>(TokensService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('performance', () => {
    it('should return token performance data', async () => {
      jest.spyOn(controller, 'getTokenPriceMovement').mockResolvedValue({
        current: 100,
        high: 120,
        low: 80,
      } as any);

      const result = await controller.performance('test_token');

      expect(result).toHaveProperty('token_id', 1);
      expect(result).toHaveProperty('past_24h');
      expect(result).toHaveProperty('past_7d');
      expect(result).toHaveProperty('past_30d');
      expect(result).toHaveProperty('all_time');
      expect(tokensService.getToken).toHaveBeenCalledWith('test_token');
    });
  });
});
