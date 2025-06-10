import { Token } from '@/tokens/entities/token.entity';
import { BullModule, getQueueToken } from '@nestjs/bull';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';

import { TokensService } from '@/tokens/tokens.service';
import { SYNC_TRANSACTIONS_QUEUE } from '../queues/constants';
import { SyncTransactionsQueue } from '../queues/sync-transactions.queue';
import { TransactionHistoryService } from '../services/transaction-history.service';
import { TransactionService } from '../services/transaction.service';

describe('TransactionHistoryService & SyncTransactionsQueue', () => {
  let service: TransactionHistoryService;
  let transactionsRepository: jest.Mocked<Repository<Transaction>>;
  let tokenRepository: jest.Mocked<Repository<Token>>;
  let dataSource: jest.Mocked<DataSource>;
  let syncTransactionsQueue: SyncTransactionsQueue;
  let transactionService: jest.Mocked<TransactionService>;
  let tokenService: jest.Mocked<TokensService>;
  let queueMock: { add: jest.Mock };

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

    queueMock = { add: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      imports: [BullModule.registerQueue({ name: SYNC_TRANSACTIONS_QUEUE })],
      providers: [
        TransactionHistoryService,
        SyncTransactionsQueue,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        { provide: getRepositoryToken(Token), useValue: tokenRepository },
        { provide: DataSource, useValue: dataSource },
        { provide: TransactionService, useValue: transactionService },
        { provide: TokensService, useValue: tokenService },
        {
          provide: getQueueToken(SYNC_TRANSACTIONS_QUEUE),
          useValue: queueMock,
        },
      ],
    }).compile();

    service = module.get<TransactionHistoryService>(TransactionHistoryService);
    syncTransactionsQueue = module.get<SyncTransactionsQueue>(
      SyncTransactionsQueue,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(syncTransactionsQueue).toBeDefined();
  });

  // it('should process a sync transaction queue job successfully', async () => {
  //   const mockJob: Job<ISyncTransactionsQueue> = {
  //     data: { saleAddress: 'ct_123' },
  //   } as any;

  //   await syncTransactionsQueue.process(mockJob);
  //   expect(tokenService.getToken).toHaveBeenCalledWith(
  //     mockJob.data.saleAddress,
  //   );
  // });

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
