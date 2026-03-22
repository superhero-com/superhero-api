import { Test, TestingModule } from '@nestjs/testing';
import { AccountTokensController } from './account-tokens.controller';
import { Repository } from 'typeorm';
import { TokenHolder } from './entities/token-holders.entity';
import { Token } from './entities/token.entity';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { paginate, Pagination } from 'nestjs-typeorm-paginate';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Reflector } from '@nestjs/core';
import { TokensService } from './tokens.service';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn(),
}));

describe('AccountTokensController', () => {
  let controller: AccountTokensController;
  let tokenHolderRepository: Repository<TokenHolder>;
  let communityFactoryService: CommunityFactoryService;
  let tokensService: jest.Mocked<TokensService>;

  beforeEach(async () => {
    tokensService = {
      getTokenRanksByAex9Address: jest.fn().mockResolvedValue(new Map()),
      getTokensByAex9Address: jest.fn().mockResolvedValue([]),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountTokensController],
      providers: [
        {
          provide: getRepositoryToken(TokenHolder),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(Token),
          useClass: Repository,
        },
        {
          provide: CommunityFactoryService,
          useValue: {
            getCurrentFactory: jest
              .fn()
              .mockResolvedValue({ address: 'default_factory' }),
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
          provide: TokensService,
          useValue: tokensService,
        },
        Reflector,
      ],
    }).compile();

    controller = module.get<AccountTokensController>(AccountTokensController);
    tokenHolderRepository = module.get<Repository<TokenHolder>>(
      getRepositoryToken(TokenHolder),
    );
    communityFactoryService = module.get<CommunityFactoryService>(
      CommunityFactoryService,
    );
    tokensService = module.get(TokensService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('listAccountTokens', () => {
    it('should return paginated token holders', async () => {
      const mockPagination: Pagination<TokenHolder> = {
        items: [
          {
            address: 'test_address',
            aex9_address: 'ct_token_1',
          } as TokenHolder,
        ],
        meta: {
          totalItems: 1,
          itemCount: 1,
          itemsPerPage: 10,
          totalPages: 1,
          currentPage: 1,
        },
      };

      (paginate as jest.Mock).mockResolvedValue(mockPagination);
      jest.spyOn(tokenHolderRepository, 'createQueryBuilder').mockReturnValue({
        orderBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      } as any);
      tokensService.getTokenRanksByAex9Address.mockResolvedValue(
        new Map([['ct_token_1', 7]]),
      );
      tokensService.getTokensByAex9Address.mockResolvedValue([
        { address: 'ct_token_1', name: 'Token 1' } as any,
      ]);

      const result = await controller.listAccountTokens('test_address');
      expect(result).toEqual({
        ...mockPagination,
        items: [
          expect.objectContaining({
            address: 'test_address',
            aex9_address: 'ct_token_1',
            token: expect.objectContaining({
              address: 'ct_token_1',
              name: 'Token 1',
              rank: 7,
            }),
          }),
        ],
      });
      expect(paginate).toHaveBeenCalled();
    });

    it('should use the factory address if factory_address is not provided', async () => {
      jest.spyOn(tokenHolderRepository, 'createQueryBuilder').mockReturnValue({
        orderBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      } as any);

      const spyGetFactory = jest.spyOn(
        communityFactoryService,
        'getCurrentFactory',
      );
      await controller.listAccountTokens('test_address');
      expect(spyGetFactory).toHaveBeenCalled();
    });
  });
});
