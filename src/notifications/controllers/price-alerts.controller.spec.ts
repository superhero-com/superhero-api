import { PriceAlertsController } from './price-alerts.controller';

const SALE = 'ct_wS3iFu3UkvprrkreRdjJJ8RrK9tLou5LeBBSbiPbmf6g51gvt';

describe('PriceAlertsController', () => {
  let challenges: any;
  let priceAlerts: any;
  let controller: PriceAlertsController;

  beforeEach(() => {
    challenges = {
      verifyAndConsumeForPriceAlert: jest.fn().mockResolvedValue(undefined),
    };
    priceAlerts = {
      listFor: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 1 }),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    controller = new PriceAlertsController(challenges, priceAlerts);
  });

  it('verifies the body-bound signature before creating', async () => {
    const dto = {
      nonce: 'n1',
      signature: 'sg_ok',
      sale_address: SALE,
      direction: 'above',
      target_ae: '0.01',
    } as any;
    await controller.create('ak_alice', dto);
    expect(challenges.verifyAndConsumeForPriceAlert).toHaveBeenCalledWith(
      'n1',
      'ak_alice',
      {
        action: 'create',
        saleAddress: SALE,
        direction: 'above',
        targetAe: '0.01',
      },
      'sg_ok',
    );
    expect(
      challenges.verifyAndConsumeForPriceAlert.mock.invocationCallOrder[0],
    ).toBeLessThan(priceAlerts.create.mock.invocationCallOrder[0]);
  });

  it('does not create or delete when the signature fails', async () => {
    challenges.verifyAndConsumeForPriceAlert.mockRejectedValue(
      new Error('Invalid signature'),
    );
    await expect(
      controller.create('ak_alice', {
        nonce: 'n',
        signature: 's',
        sale_address: SALE,
        direction: 'below',
        target_ae: '1',
      } as any),
    ).rejects.toThrow('Invalid signature');
    await expect(
      controller.remove('ak_alice', 4, { nonce: 'n', signature: 's' }),
    ).rejects.toThrow('Invalid signature');
    expect(priceAlerts.create).not.toHaveBeenCalled();
    expect(priceAlerts.remove).not.toHaveBeenCalled();
  });

  it('binds delete to the alert id', async () => {
    await controller.remove('ak_alice', 4, { nonce: 'n', signature: 's' });
    expect(challenges.verifyAndConsumeForPriceAlert).toHaveBeenCalledWith(
      'n',
      'ak_alice',
      { action: 'delete', alertId: 4 },
      's',
    );
    expect(priceAlerts.remove).toHaveBeenCalledWith('ak_alice', 4);
  });
});
