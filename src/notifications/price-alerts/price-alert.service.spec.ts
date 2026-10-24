import { BadRequestException, NotFoundException } from '@nestjs/common';
import BigNumber from 'bignumber.js';
import {
  buildPriceAlertMessage,
  canonicalPriceAlertHash,
} from './price-alert.message';
import {
  formatAe,
  PRICE_ALERT_MAX_ACTIVE,
  PriceAlertService,
} from './price-alert.service';

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
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((x) => x),
      save: jest.fn((x) =>
        Promise.resolve({ ...x, id: 5, created_at: new Date(0) }),
      ),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn().mockResolvedValue([]),
    };
    tokens = {
      findOne: jest.fn().mockResolvedValue({
        sale_address: SALE,
        symbol: 'WORD',
        price: new BigNumber('0.006'),
      }),
      find: jest
        .fn()
        .mockResolvedValue([{ sale_address: SALE, symbol: 'WORD' }]),
    };
    notifications = { send: jest.fn().mockResolvedValue({ outcome: 'sent' }) };
    service = new PriceAlertService(alerts, tokens, notifications);
  });

  it('creates an alert for a known token', async () => {
    const view = await service.create('ak_alice', SALE, 'above', '0.01');
    expect(view).toMatchObject({
      id: 5,
      symbol: 'WORD',
      direction: 'above',
      target_ae: '0.01',
      triggered_at: null,
    });
    expect(alerts.save).toHaveBeenCalled();
  });

  it('rejects bad targets', async () => {
    for (const t of ['0', '-1', 'abc', '1e5', '']) {
      await expect(
        service.create('ak_alice', SALE, 'above', t),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('rejects an alert that would fire at once', async () => {
    await expect(
      service.create('ak_alice', SALE, 'above', '0.005'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create('ak_alice', SALE, 'below', '0.007'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unknown tokens', async () => {
    tokens.findOne.mockResolvedValue(null);
    await expect(
      service.create('ak_alice', SALE, 'above', '1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('caps active alerts per account', async () => {
    alerts.count.mockResolvedValue(PRICE_ALERT_MAX_ACTIVE);
    await expect(
      service.create('ak_alice', SALE, 'above', '1'),
    ).rejects.toMatchObject({ status: 429 });
    expect(alerts.save).not.toHaveBeenCalled();
  });

  it('deletes only the owner alert', async () => {
    await service.remove('ak_alice', 3);
    expect(alerts.delete).toHaveBeenCalledWith({ id: 3, address: 'ak_alice' });
    alerts.delete.mockResolvedValue({ affected: 0 });
    await expect(service.remove('ak_bob', 3)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lists alerts with token symbols', async () => {
    alerts.find.mockResolvedValue([
      {
        id: 1,
        sale_address: SALE,
        direction: 'below',
        target_ae: '0.001',
        created_at: new Date(0),
        triggered_at: null,
      },
    ]);
    const list = await service.listFor('ak_alice');
    expect(list).toEqual([expect.objectContaining({ id: 1, symbol: 'WORD' })]);
  });

  it('fires each crossed alert once with readable copy', async () => {
    alerts.query.mockResolvedValue([
      {
        id: 9,
        address: 'ak_alice',
        sale_address: SALE,
        direction: 'above',
        target_ae: '0.0100',
        price: '0.0123456789',
        symbol: 'WORD',
      },
    ]);
    const fired = await service.checkAlerts();
    expect(fired).toBe(1);
    expect(alerts.query.mock.calls[0][0]).toContain('"triggered_at" IS NULL');
    const [notifiable, notification] = notifications.send.mock.calls[0];
    expect(notifiable).toEqual({ address: 'ak_alice' });
    expect(notification.type).toBe('token-price-alert');
    expect(notification.dedupKey(notifiable)).toBe('price-alert:9:ak_alice');
    expect(notification.toExpo().body).toBe(
      'WORD is above 0.01 AE (now 0.0123457 AE)',
    );
  });

  it('handles the pg [rows, count] UPDATE result shape', async () => {
    alerts.query.mockResolvedValue([
      [
        {
          id: 1,
          address: 'ak_a',
          sale_address: SALE,
          direction: 'below',
          target_ae: '1',
          price: '0.5',
          symbol: 'X',
        },
      ],
      1,
    ]);
    expect(await service.checkAlerts()).toBe(1);
  });

  it('never throws from the cron', async () => {
    alerts.query.mockRejectedValue(new Error('db down'));
    await expect(service.checkAlerts()).resolves.toBe(0);
    notifications.send.mockRejectedValue(new Error('boom'));
    alerts.query.mockResolvedValue([
      {
        id: 2,
        address: 'ak_a',
        sale_address: SALE,
        direction: 'below',
        target_ae: '1',
        price: '0.5',
        symbol: 'X',
      },
    ]);
    await expect(service.checkAlerts()).resolves.toBe(1);
  });
});
