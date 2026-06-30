import { PairsController } from './pairs.controller';

describe('PairsController', () => {
  let controller: PairsController;
  let pairService: {
    findAll: jest.Mock;
    findByAddress: jest.Mock;
    findByFromTokenAndToToken: jest.Mock;
    findSwapPaths: jest.Mock;
  };

  beforeEach(() => {
    pairService = {
      findAll: jest.fn().mockResolvedValue({ items: [], meta: {} }),
      findByAddress: jest.fn(),
      findByFromTokenAndToToken: jest.fn(),
      findSwapPaths: jest.fn(),
    };

    controller = new PairsController(pairService as any, {} as any, {} as any);
  });

  it('forwards search params to pairService.findAll', async () => {
    await controller.listAll('alice', 'ct_token', 2, 25, 'created_at', 'ASC');

    expect(pairService.findAll).toHaveBeenCalledWith(
      { page: 2, limit: 25 },
      'created_at',
      'ASC',
      'alice',
      'ct_token',
    );
  });

  it('forwards oversized pagination to the service (clamped there) instead of rejecting', async () => {
    // The DEX list endpoints clamp rather than 400 — pagination bounds are
    // enforced in PairService.findAll (see pair.service.spec), so the controller
    // no longer hard-rejects page<1 / limit>100.
    await expect(
      controller.listAll(undefined, undefined, 0, 100000, 'created_at', 'ASC'),
    ).resolves.toBeDefined();

    expect(pairService.findAll).toHaveBeenCalledWith(
      { page: 0, limit: 100000 },
      'created_at',
      'ASC',
      undefined,
      undefined,
    );
  });

  it('rejects out-of-range history intervals before looking up a pair', async () => {
    await expect(
      controller.getPaginatedHistory('ct_pair', 30, 'token0', 'ae', 1, 100),
    ).rejects.toThrow('interval must be between 60 and 86400 seconds');

    expect(pairService.findByAddress).not.toHaveBeenCalled();
  });
});
