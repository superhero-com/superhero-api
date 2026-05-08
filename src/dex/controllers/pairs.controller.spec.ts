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

  it('rejects invalid pair list pagination before calling the service', async () => {
    await expect(
      controller.listAll(undefined, undefined, 0, 25, 'created_at', 'ASC'),
    ).rejects.toThrow('Page must be greater than or equal to 1');
    await expect(
      controller.listAll(undefined, undefined, 1, 101, 'created_at', 'ASC'),
    ).rejects.toThrow('Limit must be between 1 and 100');

    expect(pairService.findAll).not.toHaveBeenCalled();
  });

  it('rejects out-of-range history intervals before looking up a pair', async () => {
    await expect(
      controller.getPaginatedHistory('ct_pair', 30, 'token0', 'ae', 1, 100),
    ).rejects.toThrow('interval must be between 60 and 86400 seconds');

    expect(pairService.findByAddress).not.toHaveBeenCalled();
  });
});
