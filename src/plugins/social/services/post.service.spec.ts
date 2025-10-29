import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PostService } from './post.service';
import { Post } from '../entities/post.entity';
import { ITransaction } from '@/utils/types';
import { Logger } from '@nestjs/common';

// Mock the external dependencies
jest.mock('@/utils/common');
jest.mock('../config/post-contracts.config');
jest.mock('../utils/content-parser.util');

describe('PostService', () => {
  let service: PostService;
  let repository: jest.Mocked<Repository<Post>>;
  let logger: jest.Mocked<Logger>;

  const mockRepository = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    manager: {
      transaction: jest.fn(),
    },
  };

  const createMockTransaction = (
    overrides: Partial<ITransaction> = {},
  ): ITransaction => ({
    blockHeight: 123456,
    claim: null,
    hash: 'th_testHash123',
    microIndex: 1,
    microTime: Date.now(),
    pending: false,
    tx: {
      abiVersion: 1,
      amount: 0,
      microTime: Date.now(),
      arguments: [],
      callerId: 'ak_testCaller123',
      code: '',
      commitmentId: null,
      contractId: 'ct_testContract123',
      fee: 1000,
      gas: 5000,
      gasPrice: 1000000000,
      gasUsed: 3000,
      name: null,
      nameFee: 0,
      nameId: null,
      nameSalt: '',
      nonce: 1,
      pointers: null,
      result: 'ok',
      return: { type: 'tuple', value: 'test-return-value' },
      returnType: 'ok',
      type: 'ContractCallTx' as const,
      VSN: '1',
    },
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PostService,
        {
          provide: getRepositoryToken(Post),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<PostService>(PostService);
    repository = module.get(getRepositoryToken(Post));
    logger = service['logger'] as jest.Mocked<Logger>;

    // Mock logger methods
    logger.log = jest.fn();
    logger.error = jest.fn();
    logger.warn = jest.fn();
    logger.debug = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('validateTransaction', () => {
    it('should return false for null transaction', () => {
      const result = service['validateTransaction'](null as any);
      expect(result).toBe(false);
    });

    it('should return false for transaction without required fields', () => {
      const transaction = {} as ITransaction;
      const result = service['validateTransaction'](transaction);
      expect(result).toBe(false);
    });

    it('should return true for valid transaction', () => {
      const transaction = createMockTransaction({
        tx: {
          ...createMockTransaction().tx,
          callerId: 'ak_testCaller',
          contractId: 'ct_testContract',
          arguments: [],
        },
      });

      const result = service['validateTransaction'](transaction);
      expect(result).toBe(true);
    });
  });

  describe('generatePostId', () => {
    it('should generate ID with return value when available', () => {
      const transaction = createMockTransaction({
        tx: {
          ...createMockTransaction().tx,
          return: {
            type: 'tuple',
            value: 'return-value',
          },
        },
      });

      const contract = { version: 3, contractAddress: 'test' };
      const result = service['generatePostId'](transaction, contract);

      expect(result).toBe('return-value_v3');
    });

    it('should generate fallback ID when return value is not available', () => {
      const transaction = createMockTransaction({
        hash: 'th_testHash12345678',
        tx: {
          ...createMockTransaction().tx,
          return: undefined as any,
        },
      });

      const contract = { version: 3, contractAddress: 'test' };
      const result = service['generatePostId'](transaction, contract);

      expect(result).toBe('12345678_v3');
    });
  });

  describe('handleLiveTransaction', () => {
    it('should return error for transaction without contract ID', async () => {
      const transaction = createMockTransaction({
        tx: {
          ...createMockTransaction().tx,
          contractId: undefined as any,
        },
      });

      const result = await service.handleLiveTransaction(transaction);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing contract ID or unsupported contract');
      expect(result.skipped).toBe(true);
    });

    it('should return error for unsupported contract', async () => {
      // Mock the contract support check
      const {
        isContractSupported,
      } = require('../config/post-contracts.config');
      isContractSupported.mockReturnValue(false);

      const transaction = createMockTransaction({
        tx: {
          ...createMockTransaction().tx,
          contractId: 'ct_unsupportedContract',
        },
      });

      const result = await service.handleLiveTransaction(transaction);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing contract ID or unsupported contract');
      expect(result.skipped).toBe(true);
    });

    it('should process supported contract successfully', async () => {
      // Mock the contract support and configuration
      const {
        isContractSupported,
        getContractByAddress,
      } = require('../config/post-contracts.config');
      isContractSupported.mockReturnValue(true);
      getContractByAddress.mockReturnValue({
        contractAddress: 'ct_testContract',
        version: 3,
      });

      const mockPost = { id: 'test-post-id' };
      jest
        .spyOn(service, 'savePostFromTransaction')
        .mockResolvedValue(mockPost as Post);

      const transaction = createMockTransaction({
        tx: {
          ...createMockTransaction().tx,
          contractId: 'ct_testContract',
        },
      });

      const result = await service.handleLiveTransaction(transaction);

      expect(result.success).toBe(true);
      expect(result.post).toBe(mockPost);
    });
  });

  describe('savePostFromTransaction', () => {
    it('should return null for invalid transaction', async () => {
      jest.spyOn(service as any, 'validateTransaction').mockReturnValue(false);

      const result = await service.savePostFromTransaction({} as ITransaction, {
        contractAddress: 'test',
        version: 3,
      });

      expect(result).toBeNull();
    });

    it('should return existing post if already exists', async () => {
      jest.spyOn(service as any, 'validateTransaction').mockReturnValue(true);

      const existingPost = { id: 'existing-post', tx_hash: 'th_testHash' };
      repository.findOne.mockResolvedValue(existingPost as Post);

      const transaction = createMockTransaction({
        hash: 'th_testHash',
        tx: {
          ...createMockTransaction().tx,
          arguments: [{ type: 'tuple', value: 'test content' }],
        },
      });

      const result = await service.savePostFromTransaction(transaction, {
        contractAddress: 'test',
        version: 3,
      });

      expect(result).toBe(existingPost);
    });

    it('should create new post for valid transaction', async () => {
      jest.spyOn(service as any, 'validateTransaction').mockReturnValue(true);
      jest
        .spyOn(service as any, 'generatePostId')
        .mockReturnValue('new-post-id');

      // Mock content parser
      const { parsePostContent } = require('../utils/content-parser.util');
      parsePostContent.mockReturnValue({
        content: 'parsed content',
        topics: ['#test'],
        media: [],
      });

      repository.findOne.mockResolvedValue(null);

      const newPost = { id: 'new-post-id', tx_hash: 'th_testHash' };
      const mockManager = {
        create: jest.fn().mockReturnValue(newPost),
        save: jest.fn().mockResolvedValue(newPost),
      };
      (repository.manager.transaction as jest.Mock).mockImplementation(
        (callback) => callback(mockManager),
      );

      const transaction = createMockTransaction({
        hash: 'th_testHash',
        tx: {
          ...createMockTransaction().tx,
          callerId: 'ak_testCaller',
          contractId: 'ct_testContract',
          function: 'create_community',
          arguments: [
            { type: 'tuple', value: 'test content' },
            { type: 'list', value: [] },
          ],
        },
      });

      const result = await service.savePostFromTransaction(transaction, {
        contractAddress: 'ct_testContract',
        version: 3,
      });

      expect(result).toBe(newPost);
      expect(parsePostContent).toHaveBeenCalledWith('test content', []);
    });
  });
});

/**
 * Additional test cases to implement:
 *
 * 1. loadPostsFromMdw tests:
 *    - Successful data loading
 *    - Retry mechanism on failures
 *    - Pagination handling
 *    - Empty response handling
 *
 * 2. pullLatestPosts tests:
 *    - Processing lock behavior
 *    - Error handling and recovery
 *    - URL construction
 *
 * 3. pullLatestPostsForContracts tests:
 *    - Multiple contract processing
 *    - Parallel execution
 *    - Error aggregation
 *
 * 4. Integration tests:
 *    - End-to-end transaction processing
 *    - Database interaction testing
 *    - Error scenarios
 *
 * 5. Performance tests:
 *    - Large batch processing
 *    - Memory usage
 *    - Concurrent request handling
 */
