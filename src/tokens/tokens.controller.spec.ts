/* eslint-disable @typescript-eslint/no-unused-vars */
import { Test, TestingModule } from '@nestjs/testing';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Token } from './entities/token.entity';
import { TokenHolder } from './entities/token-holders.entity';
import { paginate } from 'nestjs-typeorm-paginate';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Reflector } from '@nestjs/core';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn().mockResolvedValue({ items: [], meta: {} }),
}));

describe('TokensController', () => {
  let controller: TokensController;
  let tokensService: TokensService;
  let communityFactoryService: CommunityFactoryService;
  let tokensRepository: Repository<Token>;
  let tokenHolderRepository: Repository<TokenHolder>;

  beforeEach(async () => {
    const tokensRepositoryMock = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        andWhereInIds: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    };

    const tokenHolderRepositoryMock = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        distinct: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TokensController],
      providers: [
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
        {
          provide: getRepositoryToken(Token),
          useValue: tokensRepositoryMock,
        },
        {
          provide: getRepositoryToken(TokenHolder),
          useValue: tokenHolderRepositoryMock,
        },
        {
          provide: TokensService,
          useValue: {
            getToken: jest.fn().mockResolvedValue({
              id: 1,
              rank: 5,
              total_supply: { toNumber: () => 1000000 },
              factory_address: 'ct_123',
            }),
            findByAddress: jest.fn().mockResolvedValue({
              id: 1,
              address: 'ct_123',
              rank: 5,
              total_supply: { toNumber: () => 1000000 },
              factory_address: 'ct_123',
            }),
          },
        },
        {
          provide: CommunityFactoryService,
          useValue: {
            getCurrentFactory: jest
              .fn()
              .mockResolvedValue({ address: 'ct_123' }),
          },
        },
      ],
    }).compile();

    controller = module.get<TokensController>(TokensController);
    tokensService = module.get<TokensService>(TokensService);
    communityFactoryService = module.get<CommunityFactoryService>(
      CommunityFactoryService,
    );
    tokensRepository = module.get<Repository<Token>>(getRepositoryToken(Token));
    tokenHolderRepository = module.get<Repository<TokenHolder>>(
      getRepositoryToken(TokenHolder),
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should return paginated list of tokens', async () => {
    const result = await controller.listAll();
    expect(paginate).toHaveBeenCalled();
    expect(result).toEqual({ items: [], meta: {} });
  });

  it('should return token details by address', async () => {
    const result = await controller.findByAddress('ct_123');
    expect(tokensService.getToken).toHaveBeenCalledWith('ct_123');
    expect(result).toEqual({
      id: 1,
      rank: 5,
      total_supply: { toNumber: expect.any(Function) },
      factory_address: 'ct_123',
    });
  });

  it('should return paginated list of token holders', async () => {
    const result = await controller.listTokenHolders('ct_123');
    expect(tokensService.findByAddress).toHaveBeenCalledWith('ct_123');
    expect(paginate).toHaveBeenCalled();
    expect(result).toEqual({ items: [], meta: {} });
  });

  it('should return paginated token rankings', async () => {
    const result = await controller.listTokenRankings('ct_123');
    expect(tokensService.findByAddress).toHaveBeenCalledWith('ct_123');
    expect(paginate).toHaveBeenCalled();
    expect(result).toEqual({ items: [], meta: {} });
  });
});
