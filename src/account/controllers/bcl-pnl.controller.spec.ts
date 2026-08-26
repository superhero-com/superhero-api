import { ServiceUnavailableException } from '@nestjs/common';
import { BclPnlController } from './bcl-pnl.controller';

describe('BclPnlController', () => {
  let controller: BclPnlController;
  let bclPnlService: { calculateTokenPnls: jest.Mock };
  let aeSdkService: { sdk: { getCurrentGeneration: jest.Mock } };

  beforeEach(() => {
    bclPnlService = {
      calculateTokenPnls: jest.fn().mockResolvedValue({
        totalCostBasisAe: 0,
        totalCostBasisUsd: 0,
        totalCurrentValueAe: 0,
        totalCurrentValueUsd: 0,
        totalGainAe: 0,
        totalGainUsd: 0,
        pnls: {},
      }),
    };
    aeSdkService = {
      sdk: {
        getCurrentGeneration: jest.fn(),
      },
    };

    controller = new BclPnlController(
      bclPnlService as any,
      aeSdkService as any,
    );
  });

  describe('getPnl', () => {
    it('surfaces a node-call failure as ServiceUnavailableException', async () => {
      aeSdkService.sdk.getCurrentGeneration.mockRejectedValue(
        new Error('node down'),
      );

      await expect(
        controller.getPnl('ak_test' as any, {} as any),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('uses the current generation height when blockHeight is not provided', async () => {
      aeSdkService.sdk.getCurrentGeneration.mockResolvedValue({
        keyBlock: { height: 12345 },
      });

      const result = await controller.getPnl('ak_test' as any, {} as any);

      expect(result.block_height).toBe(12345);
    });
  });
});
