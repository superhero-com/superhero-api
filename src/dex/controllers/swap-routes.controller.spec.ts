import { SwapRoutesController } from './swap-routes.controller';

describe('SwapRoutesController', () => {
  let controller: SwapRoutesController;
  let pairService: {
    findSwapPaths: jest.Mock;
  };

  beforeEach(() => {
    pairService = {
      findSwapPaths: jest.fn(),
    };
    controller = new SwapRoutesController(pairService as any);
  });

  it('forwards the token addresses to pairService.findSwapPaths', async () => {
    pairService.findSwapPaths.mockResolvedValue({ paths: [], directPairs: [] });

    await controller.getSwapRoutes('ct_from', 'ct_to');

    expect(pairService.findSwapPaths).toHaveBeenCalledWith('ct_from', 'ct_to');
  });

  it('summarises a direct route with hasDirectPath and totalPaths', async () => {
    const directPair = { address: 'ct_pair' };
    pairService.findSwapPaths.mockResolvedValue({
      paths: [[directPair]],
      directPairs: [directPair],
    });

    const result = await controller.getSwapRoutes('ct_from', 'ct_to');

    expect(result).toEqual({
      paths: [[directPair]],
      directPairs: [directPair],
      hasDirectPath: true,
      totalPaths: 1,
    });
  });

  it('counts multi-hop paths and reports no direct path', async () => {
    const hopA = { address: 'ct_a' };
    const hopB = { address: 'ct_b' };
    pairService.findSwapPaths.mockResolvedValue({
      paths: [[hopA, hopB]],
      directPairs: [],
    });

    const result = await controller.getSwapRoutes('ct_from', 'ct_to');

    expect(result.hasDirectPath).toBe(false);
    expect(result.totalPaths).toBe(1);
    expect(result.paths).toEqual([[hopA, hopB]]);
  });

  it('returns an empty result instead of throwing when no route exists', async () => {
    pairService.findSwapPaths.mockResolvedValue({ paths: [], directPairs: [] });

    const result = await controller.getSwapRoutes('ct_from', 'ct_to');

    expect(result).toEqual({
      paths: [],
      directPairs: [],
      hasDirectPath: false,
      totalPaths: 0,
    });
  });
});
