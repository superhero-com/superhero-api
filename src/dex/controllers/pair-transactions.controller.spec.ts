import { PairTransactionsController } from './pair-transactions.controller';

describe('PairTransactionsController', () => {
  let controller: PairTransactionsController;
  let service: {
    findAll: jest.Mock;
    findByTxHash: jest.Mock;
    findByPairAddress: jest.Mock;
  };

  beforeEach(() => {
    service = {
      findAll: jest.fn().mockResolvedValue({ items: [], meta: {} }),
      findByTxHash: jest.fn(),
      findByPairAddress: jest.fn(),
    };

    controller = new PairTransactionsController(service as any);
  });

  it('forwards all filters including the date range to the service', async () => {
    await controller.listAll(
      2,
      50,
      'created_at',
      'ASC',
      'ct_pair',
      'ct_token',
      'swap_exact_tokens_for_tokens',
      'ak_account',
      '2024-01-01T00:00:00.000Z',
      '2024-02-01T00:00:00.000Z',
    );

    expect(service.findAll).toHaveBeenCalledWith(
      { page: 2, limit: 50 },
      'created_at',
      'ASC',
      'ct_pair',
      'swap_exact_tokens_for_tokens',
      'ak_account',
      'ct_token',
      '2024-01-01T00:00:00.000Z',
      '2024-02-01T00:00:00.000Z',
    );
  });

  it('forwards undefined dates when the range is not supplied', async () => {
    await controller.listAll(1, 100, 'created_at', 'DESC');

    expect(service.findAll).toHaveBeenCalledWith(
      { page: 1, limit: 100 },
      'created_at',
      'DESC',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });
});
