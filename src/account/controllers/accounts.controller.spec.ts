import { AccountsController } from './accounts.controller';
import { StreamableFile } from '@nestjs/common';
import { paginate } from 'nestjs-typeorm-paginate';
import { Logger, NotFoundException } from '@nestjs/common';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn().mockResolvedValue({ items: [], meta: {} }),
}));

describe('AccountsController', () => {
  const createQueryBuilder = () => ({
    leftJoin: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
  });

  let controller: AccountsController;
  let accountRepository: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let queryBuilder: ReturnType<typeof createQueryBuilder>;
  let accountService: {
    getChainNameForAccount: jest.Mock;
    ensureAccountFromTransactions: jest.Mock;
  };
  let profileReadService: {
    getProfile: jest.Mock;
  };
  let portfolioService: {
    resolveAccountAddress: jest.Mock;
    getPortfolioHistory: jest.Mock;
    getPnlTimeSeries: jest.Mock;
  };
  let bclPnlService: {
    calculateTradingStats: jest.Mock;
  };

  beforeEach(() => {
    queryBuilder = createQueryBuilder();
    accountRepository = {
      createQueryBuilder: jest.fn(() => queryBuilder),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };
    accountService = {
      getChainNameForAccount: jest.fn(),
      ensureAccountFromTransactions: jest.fn().mockResolvedValue(null),
    };
    profileReadService = {
      getProfile: jest.fn(),
    };
    portfolioService = {
      resolveAccountAddress: jest.fn().mockImplementation((a) => a),
      getPortfolioHistory: jest.fn().mockResolvedValue([]),
      getPnlTimeSeries: jest.fn().mockResolvedValue([]),
    };
    bclPnlService = {
      calculateTradingStats: jest.fn(),
    };

    controller = new AccountsController(
      accountRepository as any,
      portfolioService as any,
      bclPnlService as any,
      accountService as any,
      profileReadService as any,
    );
  });

  it('returns paginated accounts', async () => {
    const result = await controller.listAll(
      undefined,
      1,
      100,
      'total_volume',
      'DESC',
    );

    expect(accountRepository.createQueryBuilder).toHaveBeenCalledWith(
      'account',
    );
    expect(queryBuilder.leftJoin).not.toHaveBeenCalled();
    expect(queryBuilder.orderBy).toHaveBeenCalledWith(
      'account.total_volume',
      'DESC',
    );
    expect(paginate).toHaveBeenCalledWith(queryBuilder, {
      page: 1,
      limit: 100,
    });
    expect(result).toEqual({ items: [], meta: {} });
  });

  it('hydrates account from transactions when searching by account address', async () => {
    const address = 'ak_3yT4BoLMWVWtCEpbb3Sv3ArtetmR5kVMDANpFsezXpqHBiFGQ';

    await controller.listAll(address, 1, 10, 'total_volume', 'DESC');

    expect(accountService.ensureAccountFromTransactions).toHaveBeenCalledWith(
      address,
    );
  });

  it('continues search when account hydration fails', async () => {
    const address = 'ak_3yT4BoLMWVWtCEpbb3Sv3ArtetmR5kVMDANpFsezXpqHBiFGQ';
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    accountService.ensureAccountFromTransactions.mockRejectedValue(
      new Error('aggregation timeout'),
    );

    await expect(
      controller.listAll(address, 1, 10, 'total_volume', 'DESC'),
    ).resolves.toEqual({ items: [], meta: {} });

    expect(loggerError).toHaveBeenCalled();
    loggerError.mockRestore();
  });

  it('applies search across account addresses and names', async () => {
    await controller.listAll('alice', 1, 100, 'total_volume', 'DESC');

    expect(accountService.ensureAccountFromTransactions).not.toHaveBeenCalled();
    expect(queryBuilder.leftJoin).toHaveBeenCalledWith(
      expect.any(Function),
      'profile_cache',
      'profile_cache.address = account.address',
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledTimes(1);
    const [whereClause, params] = queryBuilder.andWhere.mock.calls[0];

    expect(whereClause).toBeDefined();
    expect(params).toBeUndefined();
  });

  it('does not apply search for blank input', async () => {
    await controller.listAll('   ', 1, 100, 'total_volume', 'DESC');

    expect(queryBuilder.leftJoin).not.toHaveBeenCalled();
    expect(queryBuilder.andWhere).not.toHaveBeenCalled();
  });

  it('rejects invalid account pagination and ordering inputs before querying', async () => {
    await expect(
      controller.listAll(undefined, 0, 100, 'total_volume', 'DESC'),
    ).rejects.toThrow('Page must be greater than or equal to 1');
    await expect(
      controller.listAll(undefined, 1, 101, 'total_volume', 'DESC'),
    ).rejects.toThrow('Limit must be between 1 and 100');
    await expect(
      controller.listAll(undefined, 1, 100, 'unsafe_field', 'DESC'),
    ).rejects.toThrow('Invalid order_by value: unsafe_field');

    expect(accountRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('throws when account is missing', async () => {
    accountRepository.findOne.mockResolvedValue(null);

    await expect(controller.getAccount('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('falls back to stored account when hydration fails', async () => {
    const account = {
      address: 'ak_3yT4BoLMWVWtCEpbb3Sv3ArtetmR5kVMDANpFsezXpqHBiFGQ',
      chain_name: null,
      chain_name_updated_at: new Date(),
    };
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    accountService.ensureAccountFromTransactions.mockRejectedValue(
      new Error('upsert failed'),
    );
    accountRepository.findOne.mockResolvedValue(account);
    profileReadService.getProfile.mockResolvedValue({
      profile: null,
      public_name: null,
    });

    const result = await controller.getAccount(account.address);

    expect(accountRepository.findOne).toHaveBeenCalledWith({
      where: { address: account.address },
    });
    expect(result).toMatchObject({ address: account.address });
    expect(loggerError).toHaveBeenCalled();
    loggerError.mockRestore();
  });

  it('hydrates account details from transactions before returning 404', async () => {
    const account = {
      address: 'ak_3yT4BoLMWVWtCEpbb3Sv3ArtetmR5kVMDANpFsezXpqHBiFGQ',
      chain_name: null,
      chain_name_updated_at: new Date(),
    };
    accountService.ensureAccountFromTransactions.mockResolvedValue(account);
    profileReadService.getProfile.mockResolvedValue({
      profile: null,
      public_name: null,
    });

    const result = await controller.getAccount(account.address);

    expect(accountService.ensureAccountFromTransactions).toHaveBeenCalledWith(
      account.address,
    );
    expect(accountRepository.findOne).not.toHaveBeenCalled();
    expect(result).toMatchObject({ address: account.address });
  });

  describe('getPortfolioPnlChart', () => {
    it('returns a StreamableFile with SVG content type', async () => {
      portfolioService.getPnlTimeSeries.mockResolvedValue([
        { gain: { ae: 1, usd: 2 } },
        { gain: { ae: 3, usd: 6 } },
        { gain: { ae: 2, usd: 4 } },
      ]);

      const result = await controller.getPortfolioPnlChart('ak_test');

      expect(result).toBeInstanceOf(StreamableFile);
    });

    it('calls getPnlTimeSeries with daily interval for a multi-day range', async () => {
      await controller.getPortfolioPnlChart(
        'ak_test',
        '2026-01-01T00:00:00Z',
        '2026-01-31T00:00:00Z',
      );

      const callArgs = portfolioService.getPnlTimeSeries.mock.calls[0][1];
      expect(callArgs.interval).toBe(86400);
    });

    it('calls getPnlTimeSeries with hourly interval for a single-day range', async () => {
      await controller.getPortfolioPnlChart(
        'ak_test',
        '2026-01-01T00:00:00Z',
        '2026-01-01T23:59:59Z',
      );

      const callArgs = portfolioService.getPnlTimeSeries.mock.calls[0][1];
      expect(callArgs.interval).toBe(3600);
    });

    it('passes raw address to getPnlTimeSeries (resolution is handled inside)', async () => {
      await controller.getPortfolioPnlChart('myname.chain');

      // The controller no longer calls resolveAccountAddress itself —
      // getPnlTimeSeries handles it internally.
      expect(portfolioService.getPnlTimeSeries).toHaveBeenCalledWith(
        'myname.chain',
        expect.anything(),
      );
    });

    it('uses usd gain values when convertTo=usd', async () => {
      // AE series goes down, USD series goes up — green stroke proves the
      // usd field was read rather than ae.
      portfolioService.getPnlTimeSeries.mockResolvedValue([
        { gain: { ae: 5, usd: 1 } },
        { gain: { ae: 1, usd: 9 } },
      ]);

      const result = await controller.getPortfolioPnlChart(
        'ak_test',
        undefined,
        undefined,
        'usd',
      );

      const svgBuffer = (result as StreamableFile).getStream().read() as Buffer;
      expect(svgBuffer.toString()).toContain('#2EB88A');
    });

    it('returns empty SVG when no data points available', async () => {
      const result = await controller.getPortfolioPnlChart('ak_test');

      const svgBuffer = (result as StreamableFile).getStream().read() as Buffer;
      expect(svgBuffer.toString()).toContain('<svg');
      expect(svgBuffer.toString()).not.toContain('<path');
    });
  });
});
