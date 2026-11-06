import { BadRequestException, NotFoundException } from '@nestjs/common';
import BigNumber from 'bignumber.js';
import {
  buildPriceAlertMessage,
  canonicalPriceAlertHash,
} from './price-alert.message';
import { formatAe, PriceAlertService } from './price-alert.service';

const SALE = 'ct_wS3iFu3UkvprrkreRdjJJ8RrK9tLou5LeBBSbiPbmf6g51gvt';

describe('price-alert message', () => {
  it('binds the body: different target or token gives a different hash', () => {
    const base = {
      action: 'create' as const,
      saleAddress: SALE,
      direction: 'above' as const,
      targetAe: '0.01',
    };
    const h = canonicalPriceAlertHash(base);
    expect(canonicalPriceAlertHash({ ...base, targetAe: '0.02' })).not.toBe(h);
    expect(canonicalPriceAlertHash({ ...base, direction: 'below' })).not.toBe(
      h,
    );
    expect(canonicalPriceAlertHash({ action: 'delete', alertId: 1 })).not.toBe(
      h,
    );
  });

  it('uses its own intent line', () => {
    const msg = buildPriceAlertMessage('ak_alice', 'n1', {
      action: 'delete',
      alertId: 7,
    });
    expect(msg.split('\n')).toEqual([
      'Superhero Notifications',
      'Price alert for ak_alice',
      `body: ${canonicalPriceAlertHash({ action: 'delete', alertId: 7 })}`,
      'nonce: n1',
    ]);
  });
});

describe('formatAe', () => {
  it('keeps small prices readable without exponent', () => {
    expect(formatAe('0.006092231978242042')).toBe('0.00609223');
    expect(formatAe('0.000000012345678')).toBe('0.0000000123457');
    expect(formatAe('12.5')).toBe('12.5');
    expect(formatAe('3')).toBe('3');
  });
});

describe('PriceAlertService', () => {
  let alerts: any;
  let tokens: any;
  let notifications: any;
  let service: PriceAlertService;

  beforeEach(() => {
    alerts = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((x) => x),
      save: jest.fn((x) =>
        Promise.resolve({ ...x, id: 5, created_at: new Date(0) }),
      ),
      query: jest.fn().mockResolvedValue([[], 0]),
    };
    tokens = {
      findOne: jest.fn().mockResolvedValue({
        sale_address: SALE,
        symbol: 'WORD',
        price: new BigNumber('0.006'),
      }),
    };
    notifications = { send: jest.fn().mockResolvedValue({ outcome: 'sent' }) };
    service = new PriceAlertService(alerts, tokens, notifications);
  });

  describe('create', () => {
    it('rejects bad targets', async () => {
      for (const t of ['0', '-1', 'abc', '1e5', '']) {
        await expect(
          service.create('ak_alice', SALE, 'above', t),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it.each([
      ['above', '0.006'],
      ['above', '0.005'],
      ['below', '0.006'],
      ['below', '0.007'],
    ] as const)(
      'rejects %s %s while the price (0.006) already meets it',
      async (direction, target) => {
        await expect(
          service.create('ak_alice', SALE, direction, target),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(alerts.save).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['above', '0.0061'],
      ['below', '0.0059'],
    ] as const)('creates %s %s', async (direction, target) => {
      await expect(
        service.create('ak_alice', SALE, direction, target),
      ).resolves.toMatchObject({
        id: 5,
        symbol: 'WORD',
        direction,
        target_ae: target,
        triggered_at: null,
      });
    });

    it('allows a below alert while the token has no price yet', async () => {
      tokens.findOne.mockResolvedValue({
        sale_address: SALE,
        symbol: 'WORD',
        price: new BigNumber(0),
      });
      await expect(
        service.create('ak_alice', SALE, 'below', '1'),
      ).resolves.toMatchObject({ id: 5 });
    });

    it('rejects unknown tokens', async () => {
      tokens.findOne.mockResolvedValue(null);
      await expect(
        service.create('ak_alice', SALE, 'above', '1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('checkAlerts', () => {
    const crossed = (id: number) => ({
      id,
      address: 'ak_a',
      sale_address: SALE,
      direction: 'below',
      target_ae: '1',
      price: '0.5',
      symbol: 'X',
    });

    it('keeps sending the other alerts when one send throws', async () => {
      // pg returns [rows, rowCount] for UPDATE ... RETURNING.
      alerts.query.mockResolvedValue([[crossed(1), crossed(2)], 2]);
      notifications.send.mockRejectedValueOnce(new Error('boom'));
      await expect(service.checkAlerts()).resolves.toBe(2);
      expect(notifications.send).toHaveBeenCalledTimes(2);
    });

    it('never throws when the database fails', async () => {
      alerts.query.mockRejectedValue(new Error('db down'));
      await expect(service.checkAlerts()).resolves.toBe(0);
    });
  });
});
