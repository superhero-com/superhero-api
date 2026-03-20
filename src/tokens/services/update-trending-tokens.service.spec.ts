import { UpdateTrendingTokensService } from './update-trending-tokens.service';
import { TRENDING_SCORE_CONFIG } from '@/configs/constants';

describe('UpdateTrendingTokensService', () => {
  let service: UpdateTrendingTokensService;
  let tokensRepository: any;
  let transactionsRepository: any;
  let tokensService: any;

  beforeEach(() => {
    tokensRepository = {
      query: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    transactionsRepository = {
      createQueryBuilder: jest.fn(),
    };
    tokensService = {
      updateMultipleTokensTrendingScores: jest.fn().mockResolvedValue(undefined),
    };

    service = new UpdateTrendingTokensService(
      tokensRepository,
      transactionsRepository,
      tokensService,
    );
  });

  it('refreshes active tokens by oldest score update first instead of market cap', async () => {
    const getRawManyTransactions = jest.fn().mockResolvedValue([
      { sale_address: 'ct_trade' },
    ]);
    transactionsRepository.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawMany: getRawManyTransactions,
    });

    tokensRepository.query
      .mockResolvedValueOnce([{ symbol: 'POST' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const symbolTokenQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ sale_address: 'ct_post' }]),
    };
    const activeTokenQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([{ sale_address: 'ct_trade' }]),
    };

    tokensRepository.createQueryBuilder
      .mockReturnValueOnce(symbolTokenQb)
      .mockReturnValueOnce(activeTokenQb);

    await service.updateTrendingTokens();

    expect(activeTokenQb.orderBy).toHaveBeenCalledWith(
      'token.trending_score_update_at',
      'ASC',
      'NULLS FIRST',
    );
    expect(activeTokenQb.limit).toHaveBeenCalledWith(
      TRENDING_SCORE_CONFIG.MAX_ACTIVE_BATCH,
    );
    expect(tokensService.updateMultipleTokensTrendingScores).toHaveBeenCalledWith([
      { sale_address: 'ct_trade' },
    ]);
  });

  it('backfills stale tokens including rows that were never updated', async () => {
    const staleQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([{ sale_address: 'ct_never_scored' }]),
    };
    tokensRepository.createQueryBuilder.mockReturnValue(staleQb);

    await service.fixOldTrendingTokens();

    expect(staleQb.andWhere).toHaveBeenCalled();
    expect(staleQb.orderBy).toHaveBeenCalledWith(
      'token.trending_score_update_at',
      'ASC',
      'NULLS FIRST',
    );
    expect(staleQb.limit).toHaveBeenCalledWith(
      TRENDING_SCORE_CONFIG.MAX_STALE_BATCH,
    );
    expect(tokensService.updateMultipleTokensTrendingScores).toHaveBeenCalledWith([
      { sale_address: 'ct_never_scored' },
    ]);
  });
});
