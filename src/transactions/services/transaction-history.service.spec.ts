import { Test, TestingModule } from '@nestjs/testing';
import { TransactionHistoryService } from './transaction-history.service';
import { Repository, DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Transaction } from '../entities/transaction.entity';
import { Token } from '@/tokens/entities/token.entity';
import moment from 'moment';
import BigNumber from 'bignumber.js';

describe('TransactionHistoryService', () => {
  let service: TransactionHistoryService;
  let transactionsRepository: jest.Mocked<Repository<Transaction>>;
  let tokenRepository: jest.Mocked<Repository<Token>>;
  let dataSource: jest.Mocked<DataSource>;

  beforeEach(async () => {
    transactionsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getOne: jest.fn().mockResolvedValue(null),
        getRawOne: jest.fn().mockResolvedValue(null),
        getRawMany: jest.fn().mockResolvedValue([]),
        limit: jest.fn().mockReturnThis(),
      }),
    } as any;

    tokenRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getOne: jest.fn().mockResolvedValue(null),
        getRawOne: jest.fn().mockResolvedValue(null),
        getRawMany: jest.fn().mockResolvedValue([]),
        limit: jest.fn().mockReturnThis(),
      }),
    } as any;

    dataSource = {
      createQueryRunner: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionHistoryService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        { provide: getRepositoryToken(Token), useValue: tokenRepository },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<TransactionHistoryService>(TransactionHistoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return oldest history info', async () => {
    const mockData = { id: 1, created_at: new Date() };
    (tokenRepository.createQueryBuilder().getRawOne as any).mockResolvedValue(
      mockData,
    );

    const result = await service.getOldestHistoryInfo('ct_123');
    expect(result).toEqual(mockData);
    expect(tokenRepository.createQueryBuilder().where).toHaveBeenCalledWith(
      'token.address = :address',
      { address: 'ct_123' },
    );
  });

  it('should return historical data', async () => {
    const mockProps = {
      token: new Token(),
      interval: 3600,
      startDate: moment().subtract(1, 'day'),
      endDate: moment(),
      mode: 'normal' as const,
    };

    const result = await service.getHistoricalData(mockProps);
    expect(result).toEqual([]);
  });

  it('should return preview data when oldest history exists', async () => {
    const mockOldestHistory = { id: 1, created_at: new Date() };
    const mockData = [{ max_buy_price: '1.23', truncated_time: new Date() }];
    (
      transactionsRepository.createQueryBuilder().getRawMany as any
    ).mockResolvedValue(mockData);

    const result = await service.getForPreview(mockOldestHistory);
    expect(result.result).toHaveLength(1);
    expect(result.result[0].last_price).toBe('1.23');
  });
});
