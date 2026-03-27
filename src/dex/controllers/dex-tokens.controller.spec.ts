import { DexTokensController } from './dex-tokens.controller';

describe('DexTokensController', () => {
  let controller: DexTokensController;
  let dexTokenService: {
    findAll: jest.Mock;
    findByAddress: jest.Mock;
    getTokenPrice: jest.Mock;
    getTokenPriceWithLiquidityAnalysis: jest.Mock;
  };

  beforeEach(() => {
    dexTokenService = {
      findAll: jest.fn().mockResolvedValue({ items: [], meta: {} }),
      findByAddress: jest.fn(),
      getTokenPrice: jest.fn(),
      getTokenPriceWithLiquidityAnalysis: jest.fn(),
    };

    controller = new DexTokensController(
      dexTokenService as any,
      {} as any,
      {} as any,
    );
  });

  it('forwards search params to dexTokenService.findAll', async () => {
    await controller.listAll(3, 20, 'wae', 'price', 'ASC');

    expect(dexTokenService.findAll).toHaveBeenCalledWith(
      { page: 3, limit: 20 },
      'wae',
      'price',
      'ASC',
    );
  });
});
