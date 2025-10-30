/* eslint-disable @typescript-eslint/no-unused-vars */
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { TokensService } from '@/plugins/bcl/services/tokens.service';
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { paginate, Pagination } from 'nestjs-typeorm-paginate';
import { Repository } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';
import { TransactionsController } from './transactions.controller';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn(),
}));
jest.mock('@/ae/community-factory.service');

describe('TransactionsController', () => {
  let controller: TransactionsController;
  let transactionsRepository: Repository<Transaction>;
  let tokenService: TokensService;
  let communityFactoryService: CommunityFactoryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [
        {
          provide: getRepositoryToken(Transaction),
          useClass: Repository,
        },
        {
          provide: TokensService,
          useValue: {
            getToken: jest
              .fn()
              .mockResolvedValue({ id: 1, address: 'test_token' }),
          },
        },
        {
          provide: CommunityFactoryService,
          useValue: {
            getCurrentFactory: jest
              .fn()
              .mockResolvedValue({ address: 'test_factory' }),
          },
        },
      ],
    }).compile();

    controller = module.get<TransactionsController>(TransactionsController);
    transactionsRepository = module.get<Repository<Transaction>>(
      getRepositoryToken(Transaction),
    );
    tokenService = module.get<TokensService>(TokensService);
    communityFactoryService = module.get<CommunityFactoryService>(
      CommunityFactoryService,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('listTransactions', () => {
    it('should return paginated transactions', async () => {
      const mockPagination: Pagination<Transaction> = {
        items: [{ id: 1, tx_hash: 'test_hash' } as Transaction],
        meta: {
          totalItems: 1,
          itemCount: 1,
          itemsPerPage: 10,
          totalPages: 1,
          currentPage: 1,
        },
      };

      (paginate as jest.Mock).mockResolvedValue(mockPagination);
      jest.spyOn(transactionsRepository, 'createQueryBuilder').mockReturnValue({
        orderBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([mockPagination.items, 1]),
      } as any);

      const result = await controller.listTransactions(
        'test_token',
        'test_account',
      );
      expect(result).toEqual(mockPagination);
      expect(paginate).toHaveBeenCalled();
    });
  });

  describe('getTransactionByHash', () => {
    it('should return a transaction by hash', async () => {
      const mockTransaction = { id: 1, tx_hash: 'test_hash' } as Transaction;
      jest.spyOn(transactionsRepository, 'createQueryBuilder').mockReturnValue({
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue(mockTransaction),
      } as any);

      const result = await controller.getTransactionByHash('test_hash');
      expect(result).toEqual(mockTransaction);
    });

    it('should throw NotFoundException if transaction does not exist', async () => {
      jest.spyOn(transactionsRepository, 'createQueryBuilder').mockReturnValue({
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue(null),
      } as any);

      await expect(
        controller.getTransactionByHash('invalid_hash'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
