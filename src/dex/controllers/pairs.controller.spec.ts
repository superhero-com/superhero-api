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

    controller = new PairsController(
      pairService as any,
      {} as any,
      {} as any,
    );
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
});
