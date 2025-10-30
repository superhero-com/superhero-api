import { Test, TestingModule } from '@nestjs/testing';
import { TransactionService } from './transaction.service';
import { Repository } from 'typeorm';
import { Transaction } from '../../plugins/bcl/entities/transaction.entity';
import { TokensService } from '@/plugins/bcl/services/tokens.service';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { TokenWebsocketGateway } from '@/plugins/bcl/gateways/token-websocket.gateway';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Token } from '@/plugins/bcl/entities/token.entity';
import { SYNC_TOKEN_HOLDERS_QUEUE } from '@/tokens/queues/constants';
import { TX_FUNCTIONS } from '@/configs';
import BigNumber from 'bignumber.js';
import moment from 'moment';
import { getQueueToken } from '@nestjs/bull';

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
  let syncTokenHoldersQueue: jest.Mocked<Queue>;

  beforeEach(async () => {
    transactionRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(),
      }),
      save: jest.fn(),
      update: jest.fn(),
    } as any;

    tokenService = {
      getToken: jest.fn(),
      findOne: jest.fn(),
      syncTokenPrice: jest.fn(),
      updateTokenMetaDataFromCreateTx: jest.fn(),
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
        .mockResolvedValue({ address: 'test_factory' }),
    } as any;

    tokenWebsocketGateway = {
      handleTokenHistory: jest.fn(),
    } as any;

    syncTokenHoldersQueue = { add: jest.fn() } as any;

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
          provide: getQueueToken(SYNC_TOKEN_HOLDERS_QUEUE),
          useValue: syncTokenHoldersQueue,
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
    transactionRepository.getOne = jest.fn().mockResolvedValue(null);
    tokenService.getToken = jest.fn().mockResolvedValue(new Token());
    tokenService.findOne = jest.fn().mockResolvedValue(new Token());
    service.parseTransactionData = jest.fn().mockResolvedValue({
      volume: new BigNumber(10),
      amount: new BigNumber(100),
      total_supply: new BigNumber(1000),
    });
    const transactions = [
      {
        tx: {
          function: TX_FUNCTIONS.buy,
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
          function: TX_FUNCTIONS.create_community,
          contractId: 'ct_123',
          callerId: 'ak_123',
          decodedData: [
            { name: 'Mint', args: [null, '100'] },
            { name: 'PriceChange', args: [1, 2] },
          ],
          return: {
            value: [{ value: 'ct_123' }, { value: ['ct_123', 'ct_456'] }],
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
        function: TX_FUNCTIONS.buy,
        decodedData: [{ name: 'Mint', args: [null, '100'] }],
      },
    };

    const result = await service.parseTransactionData(rawTransaction);
    expect(result.volume).toBeInstanceOf(BigNumber);
    expect(result.amount).toBeInstanceOf(BigNumber);
    expect(result.total_supply).toBeInstanceOf(BigNumber);
  });
});
