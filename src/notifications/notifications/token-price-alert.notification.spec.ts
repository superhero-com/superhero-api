import { TokenPriceAlertNotification } from './token-price-alert.notification';

describe('TokenPriceAlertNotification', () => {
  const params = {
    alertId: 9,
    saleAddress: 'ct_sale',
    symbol: 'WORD',
    direction: 'above' as const,
    targetAe: '0.01',
    priceAe: '0.0123457',
  };

  it('routes through the expo, database and web-push channels', () => {
    const n = new TokenPriceAlertNotification(params);
    expect(n.via()).toEqual(['expo', 'database', 'web-push']);
    expect(n.type).toBe('token-price-alert');
  });

  it('exposes catalog META mirrored onto the instance', () => {
    const n = new TokenPriceAlertNotification(params);
    expect(n.title).toBe(TokenPriceAlertNotification.META.title);
    expect(n.description).toBe(TokenPriceAlertNotification.META.description);
  });

  it('dedups per alert and recipient', () => {
    const n = new TokenPriceAlertNotification(params);
    expect(n.dedupKey({ address: 'ak_alice' as any })).toBe(
      'price-alert:9:ak_alice',
    );
  });

  it('renders the alert with the token to open', () => {
    const msg = new TokenPriceAlertNotification(params).toExpo();
    expect(msg.title).toBe('WORD price alert');
    expect(msg.body).toBe('WORD is above 0.01 AE (now 0.0123457 AE)');
    expect(msg.data).toEqual({ type: 'token-price-alert', ...params });
  });

  it('renders the same content for the database feed as for expo', () => {
    const n = new TokenPriceAlertNotification(params);
    expect(n.toDatabase()).toEqual(n.toExpo());
  });
});
