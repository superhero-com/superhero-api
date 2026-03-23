const redisMock = {
  ping: jest.fn().mockResolvedValue('PONG'),
  del: jest.fn().mockResolvedValue(1),
  pipeline: jest.fn(),
};

jest.mock('ioredis', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => redisMock),
  };
});

import { PopularRankingService } from './popular-ranking.service';

describe('PopularRankingService', () => {
  let service: PopularRankingService;
  let postRepository: any;
  let tipRepository: any;
  let trendingTagRepository: any;
  let accountRepository: any;
  let tokenHolderRepository: any;
  let invitationRepository: any;
  let postReadsRepository: any;

  beforeEach(() => {
    const candidateQueryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        {
          id: 'post-1',
          sender_address: 'ak_author',
          created_at: new Date().toISOString(),
          total_comments: 0,
          content: '',
          topics: [],
        },
      ]),
    };
    const tipQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const holderQueryBuilder = {
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const invitationQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const readsQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    postRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(candidateQueryBuilder),
    };
    tipRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(tipQueryBuilder),
    };
    trendingTagRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    accountRepository = {
      findBy: jest.fn().mockResolvedValue([]),
    };
    tokenHolderRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(holderQueryBuilder),
    };
    invitationRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(invitationQueryBuilder),
    };
    postReadsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(readsQueryBuilder),
    };

    service = new PopularRankingService(
      postRepository as any,
      tipRepository as any,
      trendingTagRepository as any,
      accountRepository as any,
      tokenHolderRepository as any,
      {} as any,
      { sdk: { getBalance: jest.fn() } } as any,
      invitationRepository as any,
      postReadsRepository as any,
      [],
    );
  });

  it('excludes self-tips from popular ranking tip aggregates', async () => {
    await service.recompute('24h', 10);

    const tipQueryBuilder = tipRepository.createQueryBuilder.mock.results[0].value;

    expect(tipQueryBuilder.innerJoin).toHaveBeenCalledWith(
      expect.any(Function),
      'post',
      'post.id = tip.post_id',
    );
    expect(tipQueryBuilder.andWhere).toHaveBeenCalledWith(
      'tip.sender_address != post.sender_address',
    );
  });
});
