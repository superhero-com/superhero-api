import { SwapRoutesController } from './swap-routes.controller';

describe('SwapRoutesController', () => {
  let controller: SwapRoutesController;
  let pairService: {
    findSwapPaths: jest.Mock;
  };

  const makePair = (
    address: string,
    token0: string,
    token1: string,
    reserve0: string = '100',
    reserve1: string = '200',
    total_supply: string = '300',
  ) =>
    ({
      address,
      token0: { address: token0 },
      token1: { address: token1 },
      reserve0,
      reserve1,
      total_supply,
    }) as any;

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

  it('maps each pair to the legacy route shape (synchronized + liquidityInfo + address tokens)', async () => {
    pairService.findSwapPaths.mockResolvedValue({
      paths: [[makePair('ct_pair', 'ct_from', 'ct_to', '100', '200', '300')]],
      directPairs: [],
    });

    const result = await controller.getSwapRoutes('ct_from', 'ct_to');

    expect(result).toEqual([
      [
        {
          address: 'ct_pair',
          synchronized: true,
          token0: 'ct_from',
          token1: 'ct_to',
          liquidityInfo: {
            totalSupply: '300',
            reserve0: '100',
            reserve1: '200',
          },
        },
      ],
    ]);
  });

  it('marks a pair as not synchronized when either reserve is zero', async () => {
    pairService.findSwapPaths.mockResolvedValue({
      paths: [[makePair('ct_empty', 'ct_from', 'ct_to', '0', '200')]],
      directPairs: [],
    });

    const [[routePair]] = await controller.getSwapRoutes('ct_from', 'ct_to');

    // The swap UI filters routes by `pairs.every(p => p.synchronized)`, so this
    // empty pool must report synchronized=false rather than undefined.
    expect(routePair.synchronized).toBe(false);
  });

  it('preserves multi-hop route ordering', async () => {
    pairService.findSwapPaths.mockResolvedValue({
      paths: [
        [
          makePair('ct_a', 'ct_from', 'ct_mid'),
          makePair('ct_b', 'ct_mid', 'ct_to'),
        ],
      ],
      directPairs: [],
    });

    const result = await controller.getSwapRoutes('ct_from', 'ct_to');

    expect(result[0].map((p) => p.address)).toEqual(['ct_a', 'ct_b']);
  });

  it('returns an empty array instead of throwing when no route exists', async () => {
    pairService.findSwapPaths.mockResolvedValue({ paths: [], directPairs: [] });

    const result = await controller.getSwapRoutes('ct_from', 'ct_to');

    expect(result).toEqual([]);
  });
});
