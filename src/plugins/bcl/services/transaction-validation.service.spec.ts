import BigNumber from 'bignumber.js';
import { BCL_FUNCTIONS } from '@/configs';
import { TransactionValidationService } from './transaction-validation.service';

describe('TransactionValidationService', () => {
  let service: TransactionValidationService;
  let createQueryBuilder: jest.Mock;

  beforeEach(() => {
    createQueryBuilder = jest.fn();
    service = new TransactionValidationService({
      createQueryBuilder,
    } as any);
  });

  it('allows reprocessing previously broken buy transactions', async () => {
    const getOne = jest.fn().mockResolvedValue({
      tx_hash: 'th_broken',
      tx_type: BCL_FUNCTIONS.buy,
      verified: false,
      volume: new BigNumber(0),
      amount: { ae: '0' },
      unit_price: { ae: 'NaN' },
      previous_buy_price: { ae: 'NaN' },
      buy_price: { ae: 'NaN' },
      market_cap: { ae: 'NaN' },
    });

    createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      getOne,
    });

    await expect(
      service.validateTransaction({
        hash: 'th_broken',
        function: BCL_FUNCTIONS.buy,
        contract_id: 'ct_sale',
        raw: {},
      } as any),
    ).resolves.toEqual({
      isValid: true,
      saleAddress: 'ct_sale',
    });
  });

  it('skips already-processed healthy transactions', async () => {
    const getOne = jest.fn().mockResolvedValue({
      tx_hash: 'th_healthy',
      tx_type: BCL_FUNCTIONS.buy,
      verified: false,
      volume: new BigNumber(10),
      amount: { ae: '1' },
      unit_price: { ae: '0.1' },
      previous_buy_price: { ae: '0.09' },
      buy_price: { ae: '0.1' },
      market_cap: { ae: '100' },
    });

    createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      getOne,
    });

    await expect(
      service.validateTransaction({
        hash: 'th_healthy',
        function: BCL_FUNCTIONS.buy,
        contract_id: 'ct_sale',
        raw: {},
      } as any),
    ).resolves.toEqual({
      isValid: false,
      saleAddress: null,
    });
  });
});
