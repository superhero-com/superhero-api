import { Token } from '@/tokens/entities/token.entity';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';

import { TokensService } from '@/tokens/tokens.service';
import { TransactionHistoryService } from './transaction-history.service';
import { TransactionService } from './transaction.service';

describe('TransactionHistoryService', () => {
  let service: TransactionHistoryService;
  let transactionsRepository: jest.Mocked<Repository<Transaction>>;
  let tokenRepository: jest.Mocked<Repository<Token>>;
  let dataSource: jest.Mocked<DataSource>;
  let transactionService: jest.Mocked<TransactionService>;
  let tokenService: jest.Mocked<TokensService>;

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

    transactionService = {
      saveTransaction: jest.fn().mockResolvedValue({}),
    } as any;

    tokenService = {
      getToken: jest.fn().mockResolvedValue(new Token()),
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
        { provide: TransactionService, useValue: transactionService },
        { provide: TokensService, useValue: tokenService },
      ],
    }).compile();

    service = module.get<TransactionHistoryService>(TransactionHistoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // it('should fetch and save transactions successfully', async () => {
  //   const mockToken = new Token();
  //   mockToken.sale_address = 'ct_123';

  //   jest.spyOn(global, 'fetchJson').mockResolvedValue({ data: [], next: null });
  //   await syncTransactionsQueue.fetchAndSaveTransactions(
  //     mockToken,
  //     'http://example.com',
  //   );
  //   expect(fetchJson).toHaveBeenCalledWith('http://example.com');
  // });
});
