import {
  ExpoPushClient,
  ExpoPushClientError,
  isExpoPushToken,
} from './expo-push.client';

describe('isExpoPushToken', () => {
  it('accepts both Expo token forms', () => {
    expect(isExpoPushToken('ExponentPushToken[abc]')).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[abc]')).toBe(true);
  });

  it('rejects malformed tokens', () => {
    expect(isExpoPushToken('abc')).toBe(false);
    expect(isExpoPushToken('')).toBe(false);
    expect(isExpoPushToken(undefined)).toBe(false);
    expect(isExpoPushToken('ExponentPushToken[]')).toBe(false);
  });
});

describe('ExpoPushClient', () => {
  const config = {
    expoPushBatchSize: 2,
    expoAccessToken: undefined,
    receiptDelayMs: 900_000,
    expoFetchTimeoutMs: 15_000,
  } as any;
  let client: ExpoPushClient;
  let fetchMock: jest.Mock;

  const jsonResponse = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const htmlResponse = (status: number, body = '<html>broken</html>') => ({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === 'content-type' ? 'text/html' : null,
    },
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
    text: async () => body,
  });

  beforeEach(() => {
    client = new ExpoPushClient(config);
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  it('posts messages and returns the tickets array', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ status: 'ok', id: 'r1' }] }),
    );

    const tickets = await client.sendPushNotificationsAsync([{ to: 't1' }]);

    expect(tickets).toEqual([{ status: 'ok', id: 'r1' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/push/send');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeDefined();
  });

  it('fetches receipts keyed by ticket id', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { r1: { status: 'ok' } } }),
    );
    const receipts = await client.getPushNotificationReceiptsAsync(['r1']);
    expect(receipts).toEqual({ r1: { status: 'ok' } });
  });

  it('throws ExpoPushClientError on a non-OK Expo response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad' }, 400));
    await expect(
      client.sendPushNotificationsAsync([{ to: 't1' }]),
    ).rejects.toBeInstanceOf(ExpoPushClientError);
  });

  it('throws structured ExpoPushClientError on a non-JSON 200 (CDN interstitial)', async () => {
    fetchMock.mockResolvedValue(htmlResponse(200));
    await expect(
      client.sendPushNotificationsAsync([{ to: 't1' }]),
    ).rejects.toThrow(/non-JSON/);
  });

  it('aborts with a clear error when the request exceeds the configured timeout', async () => {
    const fast = new ExpoPushClient({
      ...config,
      expoFetchTimeoutMs: 5,
    } as any);
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err: Error & { name: string } = new Error('aborted') as any;
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    await expect(
      fast.sendPushNotificationsAsync([{ to: 't1' }]),
    ).rejects.toThrow(/timeout/);
  });

  it('adds an Authorization header when an access token is configured', async () => {
    client = new ExpoPushClient({
      ...config,
      expoAccessToken: 'secret',
    } as any);
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    await client.sendPushNotificationsAsync([{ to: 't1' }]);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer secret');
  });
});
