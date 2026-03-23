import { Test, TestingModule } from '@nestjs/testing';
import { TransactionService } from './transaction.service';
import { Repository } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';
import { TokensService } from '@/tokens/tokens.service';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { TokenWebsocketGateway } from '@/tokens/token-websocket.gateway';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Token } from '@/tokens/entities/token.entity';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { BCL_FUNCTIONS } from '@/configs';
import BigNumber from 'bignumber.js';
import moment from 'moment';

jest.mock('@/tokens/tokens.service');
jest.mock('@/ae-pricing/ae-pricing.service');
jest.mock('@/ae/community-factory.service');
jest.mock('@/tokens/token-websocket.gateway');

describe('TransactionService', () => {
  let service: TransactionService;
  let transactionRepository: any | jest.Mocked<Repository<Transaction>>;
  let tokenService: jest.Mocked<TokensService>;
  let aePricingService: jest.Mocked<AePricingService>;
  let communityFactoryService: jest.Mocked<CommunityFactoryService>;
  let tokenWebsocketGateway: jest.Mocked<TokenWebsocketGateway>;
  let tokenHolderRepository: any | jest.Mocked<Repository<TokenHolder>>;

  beforeEach(async () => {
    transactionRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(),
      }),
      save: jest.fn(),
      update: jest.fn(),
    } as any;

    tokenHolderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        getOne: jest.fn().mockResolvedValue(null),
      }),
      save: jest.fn(),
      update: jest.fn(),
    } as any;

    tokenService = {
      getToken: jest.fn(),
      findByAddress: jest.fn(),
      createTokenFromRawTransaction: jest.fn(),
      syncTokenPrice: jest.fn(),
      updateTokenMetaDataFromCreateTx: jest.fn(),
      update: jest.fn(),
      loadAndSaveTokenHoldersFromMdw: jest.fn(),
      updateTokenTrendingScore: jest.fn(),
    } as any;

    aePricingService = {
      getPriceData: jest.fn(),
    } as any;

    communityFactoryService = {
      loadFactory: jest
        .fn()
        .mockResolvedValue({ contract: { $decodeEvents: jest.fn() } }),
      getCurrentFactory: jest
        .fn()
        .mockResolvedValue({
          address: 'test_factory',
          collections: { default: {} },
        }),
    } as any;

    tokenWebsocketGateway = {
      handleTokenHistory: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionRepository,
        },
        { provide: TokensService, useValue: tokenService },
        { provide: AePricingService, useValue: aePricingService },
        { provide: CommunityFactoryService, useValue: communityFactoryService },
        { provide: TokenWebsocketGateway, useValue: tokenWebsocketGateway },
        {
          provide: getRepositoryToken(TokenHolder),
          useValue: tokenHolderRepository,
        },
      ],
    }).compile();

    service = module.get<TransactionService>(TransactionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should not save a transaction if the function is not in TX_FUNCTIONS', async () => {
    const rawTransaction: any = { tx: { function: 'invalid_function' } };
    const result = await service.saveTransaction(rawTransaction);
    expect(result).toBeUndefined();
  });

  it('should save a new transaction when valid', async () => {
    const deleteOldCreateCommunityQuery = {
      delete: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const existingTxQuery = {
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    transactionRepository.createQueryBuilder.mockImplementation((alias: string) =>
      alias === 'transactions' ? deleteOldCreateCommunityQuery : existingTxQuery,
    );
    tokenService.getToken = jest.fn().mockResolvedValue({
      sale_address: 'ct_123',
      factory_address: 'test_factory',
      collection: 'default',
    } as Token);
    service.parseTransactionData = jest.fn().mockResolvedValue({
      volume: new BigNumber(10),
      amount: new BigNumber(100),
      total_supply: new BigNumber(1000),
      protocol_reward: new BigNumber(1),
      _should_revalidate: false,
    });
    const transactions = [
      {
        tx: {
          function: BCL_FUNCTIONS.buy,
          contractId: 'ct_123',
          callerId: 'ak_123',
          decodedData: [
            { name: 'Mint', args: [null, '100'] },
            { name: 'PriceChange', args: [1, 2] },
          ],
        },
        hash: 'tx_123',
        blockHeight: 100,
        microIndex: 1,
        microTime: moment().subtract(1, 'hour').valueOf(),
      },
      {
        tx: {
          function: BCL_FUNCTIONS.create_community,
          contractId: 'ct_123',
          callerId: 'ak_123',
          decodedData: [
            { name: 'Mint', args: [null, '100'] },
            { name: 'PriceChange', args: [1, 2] },
          ],
          return: {
            value: [{ value: 'ct_123' }, { value: 'ct_456' }],
          },
        },
        hash: 'tx_123',
        blockHeight: 100,
        microIndex: 1,
        microTime: moment().subtract(1, 'hour').valueOf(),
      },
    ];
    for (const transaction of transactions) {
      service.decodeTransactionData = jest.fn().mockResolvedValue(transaction);
      aePricingService.getPriceData = jest
        .fn()
        .mockResolvedValue(new BigNumber(1));
      transactionRepository.save = jest
        .fn()
        .mockResolvedValue(new Transaction());

      const result = await service.saveTransaction(transaction as any);
      expect(transactionRepository.save).toHaveBeenCalled();
      expect(result).toBeInstanceOf(Transaction);
    }
  });

  it('should handle parseTransactionData correctly', async () => {
    const rawTransaction: any = {
      tx: {
        function: BCL_FUNCTIONS.buy,
        decodedData: [
          { name: 'Mint', args: [null, '1000000000000000000'] },
          {
            name: 'Buy',
            args: ['2000000000000000000', null, '3000000000000000000'],
          },
        ],
      },
    };

    const result = await service.parseTransactionData(rawTransaction);
    expect(result.volume).toBeInstanceOf(BigNumber);
    expect(result.amount).toBeInstanceOf(BigNumber);
    expect(result.total_supply).toBeInstanceOf(BigNumber);
  });

  it('should not create a holder row for a sell with no existing holder', async () => {
    const holderCountQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
    };
    const existingHolderQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };

    tokenHolderRepository.createQueryBuilder
      .mockReturnValueOnce(holderCountQuery)
      .mockReturnValueOnce(existingHolderQuery);

    await service.updateTokenHolder(
      {
        address: 'ct_token',
        sale_address: 'ct_sale',
        holders_count: 0,
      } as Token,
      {
        tx: {
          function: BCL_FUNCTIONS.sell,
          callerId: 'ak_user',
        },
        hash: 'th_sell',
        blockHeight: 42,
      } as any,
      new BigNumber(1),
    );

    expect(tokenHolderRepository.save).not.toHaveBeenCalled();
    expect(tokenService.update).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ holders_count: expect.any(Number) }),
    );
    expect(tokenService.loadAndSaveTokenHoldersFromMdw).toHaveBeenCalledWith(
      'ct_sale',
    );
  });
});
