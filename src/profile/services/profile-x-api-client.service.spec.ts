import { ProfileXApiClientService } from './profile-x-api-client.service';

// Builds a fake fetch Response good enough for the service: it only reads
// `ok`, `status`, and `json()`.
const mockResponse = (status: number, body: any = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// Drains the microtask queue so awaited promises chained off resolved
// fetch/json mocks settle before we inspect state or advance timers.
const flush = () => Promise.resolve();

const baseTokenParams = (overrides: Partial<any> = {}) => {
  const warn = jest.fn();
  return {
    params: {
      appKey: 'app-key',
      appSecret: 'app-secret',
      tokenEndpoints: [
        {
          baseUrl: 'https://api.x.com',
          url: 'https://api.x.com/oauth2/token',
          body: new URLSearchParams({ grant_type: 'client_credentials' }),
        },
      ],
      logger: { warn },
      missingCredentialsMessage: 'missing-credentials',
      tokenFailureMessage: 'token-failure',
      tokenErrorPrefix: 'token-error',
      timeoutMs: 5000,
      ...overrides,
    },
    warn,
  };
};

describe('ProfileXApiClientService', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  let service: ProfileXApiClientService;

  beforeEach(() => {
    service = new ProfileXApiClientService();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('getXAppAccessToken', () => {
    it('returns null and logs missing-credentials without fetching when appKey is absent', async () => {
      const { params, warn } = baseTokenParams({ appKey: undefined });

      const result = await service.getXAppAccessToken(params);

      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledWith('missing-credentials');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null and logs missing-credentials without fetching when appSecret is absent', async () => {
      const { params, warn } = baseTokenParams({ appSecret: '' });

      const result = await service.getXAppAccessToken(params);

      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledWith('missing-credentials');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns the access token on a 200 from the first endpoint', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(200, { access_token: 'tok', expires_in: 3600 }),
      );
      const { params } = baseTokenParams();

      const result = await service.getXAppAccessToken(params);

      expect(result).toBe('tok');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('serves a cached token on a second call with the same params (no second fetch)', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(200, { access_token: 'tok', expires_in: 3600 }),
      );
      const { params } = baseTokenParams();

      const first = await service.getXAppAccessToken(params);
      expect(first).toBe('tok');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Fresh params object, identical contents -> same hash cache key.
      const { params: params2 } = baseTokenParams();
      const second = await service.getXAppAccessToken(params2);

      expect(second).toBe('tok');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after the cached token TTL expires', async () => {
      jest.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(
          // expires_in 90 -> ttl = max(90-60, 30) = 30s
          mockResponse(200, { access_token: 'tok-1', expires_in: 90 }),
        )
        .mockResolvedValueOnce(
          mockResponse(200, { access_token: 'tok-2', expires_in: 90 }),
        );
      const { params } = baseTokenParams();

      expect(await service.getXAppAccessToken(params)).toBe('tok-1');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Still inside TTL window -> cached.
      await jest.advanceTimersByTimeAsync(29_000);
      expect(await service.getXAppAccessToken(params)).toBe('tok-1');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Cross 30s TTL boundary -> re-fetch.
      await jest.advanceTimersByTimeAsync(2_000);
      expect(await service.getXAppAccessToken(params)).toBe('tok-2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('falls back to the second endpoint within one attempt on a non-retryable failure', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse(400, { error: 'invalid_request' }))
        .mockResolvedValueOnce(
          mockResponse(200, { access_token: 'tok', expires_in: 3600 }),
        );
      const { params } = baseTokenParams({
        tokenEndpoints: [
          {
            baseUrl: 'https://api.x.com',
            url: 'https://api.x.com/oauth2/token',
            body: new URLSearchParams({ grant_type: 'client_credentials' }),
          },
          {
            baseUrl: 'https://api.twitter.com',
            url: 'https://api.twitter.com/oauth2/token',
            body: new URLSearchParams({ grant_type: 'client_credentials' }),
          },
        ],
      });

      const result = await service.getXAppAccessToken(params);

      expect(result).toBe('tok');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries after backoff on a transient failure and succeeds on the second attempt', async () => {
      jest.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(mockResponse(429, { detail: 'rate limited' }))
        .mockResolvedValueOnce(
          mockResponse(200, { access_token: 'tok', expires_in: 3600 }),
        );
      const { params } = baseTokenParams();

      const promise = service.getXAppAccessToken(params);

      // First attempt resolves (429) and schedules a 500ms backoff sleep.
      await flush();
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Backoff base delay = 500ms for attempt 1 (500 * 2^0).
      await jest.advanceTimersByTimeAsync(500);

      expect(await promise).toBe('tok');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries up to 3 attempts and treats 5xx as transient before succeeding', async () => {
      jest.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(mockResponse(503, {}))
        .mockResolvedValueOnce(mockResponse(500, {}))
        .mockResolvedValueOnce(
          mockResponse(200, { access_token: 'tok', expires_in: 3600 }),
        );
      const { params } = baseTokenParams();

      const promise = service.getXAppAccessToken(params);

      await flush();
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // attempt 1 backoff: 500 * 2^0 = 500ms
      await jest.advanceTimersByTimeAsync(500);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // attempt 2 backoff: 500 * 2^1 = 1000ms
      await jest.advanceTimersByTimeAsync(1000);

      expect(await promise).toBe('tok');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('sets a 60s cooldown after all attempts fail and blocks immediate retries', async () => {
      jest.useFakeTimers();
      // Single non-retryable failure -> one fetch, no retries, cooldown armed.
      fetchMock.mockResolvedValue(mockResponse(400, { error: 'invalid' }));
      const { params, warn } = baseTokenParams();

      const first = await service.getXAppAccessToken(params);
      expect(first).toBeNull();
      expect(warn).toHaveBeenCalledWith('token-failure', expect.any(Object));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Within cooldown: returns null WITHOUT fetching again.
      const blocked = await service.getXAppAccessToken(params);
      expect(blocked).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // After 60s cooldown elapses, it fetches again.
      await jest.advanceTimersByTimeAsync(60_001);
      const after = await service.getXAppAccessToken(params);
      expect(after).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns null via the outer catch and logs the error prefix when fetch rejects on every attempt', async () => {
      jest.useFakeTimers();
      fetchMock.mockRejectedValue(new Error('network down'));
      const { params, warn } = baseTokenParams();

      const promise = service.getXAppAccessToken(params);

      // attempt 1 throws -> backoff 500ms
      await flush();
      await flush();
      await jest.advanceTimersByTimeAsync(500);
      await flush();
      // attempt 2 throws -> backoff 1000ms
      await jest.advanceTimersByTimeAsync(1000);
      await flush();
      // attempt 3 throws -> rethrown to outer catch

      const result = await promise;

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('token-error: network down'),
      );
    });

    it('clears an existing cooldown after a later successful fetch', async () => {
      jest.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(mockResponse(400, { error: 'invalid' }))
        .mockResolvedValueOnce(
          mockResponse(200, { access_token: 'tok', expires_in: 3600 }),
        );
      const { params } = baseTokenParams();

      // Arm the cooldown.
      expect(await service.getXAppAccessToken(params)).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Let the cooldown elapse, then a success resets blocked-until.
      await jest.advanceTimersByTimeAsync(60_001);
      expect(await service.getXAppAccessToken(params)).toBe('tok');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The cooldown no longer blocks: cached token is returned (still no new fetch).
      expect(await service.getXAppAccessToken(params)).toBe('tok');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('fetchXReadWithAuthFallback', () => {
    it('returns the api.x.com result on success and sticks that host for the key', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { data: 'ok' }));

      const result = await service.fetchXReadWithAuthFallback(
        '/2/users/by/username/foo',
        'bearer',
        5000,
        'key-1',
      );

      expect(result.baseUrl).toBe('https://api.x.com');
      expect(result.body).toEqual({ data: 'ok' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        (fetchMock.mock.calls[0][0] as string).startsWith('https://api.x.com'),
      ).toBe(true);

      // Next call prefers the remembered host first.
      await service.fetchXReadWithAuthFallback(
        '/2/users/by/username/bar',
        'bearer',
        5000,
        'key-1',
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        (fetchMock.mock.calls[1][0] as string).startsWith('https://api.x.com'),
      ).toBe(true);
    });

    it('falls through to api.twitter.com on an unsupported-auth 403 and then prefers twitter', async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockResponse(403, { detail: 'Unsupported Authentication scheme' }),
        )
        .mockResolvedValueOnce(mockResponse(200, { data: 'tw' }));

      const result = await service.fetchXReadWithAuthFallback(
        '/2/path',
        'bearer',
        5000,
        'key-2',
      );

      expect(result.baseUrl).toBe('https://api.twitter.com');
      expect(result.body).toEqual({ data: 'tw' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        (fetchMock.mock.calls[0][0] as string).startsWith('https://api.x.com'),
      ).toBe(true);
      expect(
        (fetchMock.mock.calls[1][0] as string).startsWith(
          'https://api.twitter.com',
        ),
      ).toBe(true);

      // twitter is now the preferred host -> tried first next time.
      fetchMock.mockResolvedValueOnce(mockResponse(200, { data: 'tw2' }));
      const second = await service.fetchXReadWithAuthFallback(
        '/2/again',
        'bearer',
        5000,
        'key-2',
      );
      expect(second.baseUrl).toBe('https://api.twitter.com');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(
        (fetchMock.mock.calls[2][0] as string).startsWith(
          'https://api.twitter.com',
        ),
      ).toBe(true);
    });

    it('does NOT fall through on a non-auth error (404) and returns immediately', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(404, { title: 'Not Found' }),
      );

      const result = await service.fetchXReadWithAuthFallback(
        '/2/missing',
        'bearer',
        5000,
        'key-3',
      );

      expect(result.baseUrl).toBe('https://api.x.com');
      expect(result.response.status).toBe(404);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT treat a 403 without unsupported-auth detail as a fallback trigger', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(403, { detail: 'Forbidden for other reasons' }),
      );

      const result = await service.fetchXReadWithAuthFallback(
        '/2/forbidden',
        'bearer',
        5000,
        'key-4',
      );

      expect(result.baseUrl).toBe('https://api.x.com');
      expect(result.response.status).toBe(403);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps per-key stickiness independent across keys', async () => {
      // key-A succeeds on twitter via fallback; key-B should still start on x.com.
      fetchMock
        .mockResolvedValueOnce(
          mockResponse(403, { detail: 'Unsupported Authentication' }),
        )
        .mockResolvedValueOnce(mockResponse(200, { data: 'tw' }));
      await service.fetchXReadWithAuthFallback('/p', 'bearer', 5000, 'key-A');

      fetchMock.mockResolvedValueOnce(mockResponse(200, { data: 'x' }));
      const resB = await service.fetchXReadWithAuthFallback(
        '/p',
        'bearer',
        5000,
        'key-B',
      );

      expect(resB.baseUrl).toBe('https://api.x.com');
      // 2 calls for key-A + 1 for key-B
      expect(
        (fetchMock.mock.calls[2][0] as string).startsWith('https://api.x.com'),
      ).toBe(true);
    });
  });

  describe('extractXApiErrorDetail', () => {
    const callExtract = (body: any) => service.extractXApiErrorDetail(body);

    it('prefers error_description, then detail, then title, then error', () => {
      expect(
        callExtract({
          error_description: 'desc',
          detail: 'det',
          title: 'tit',
          error: 'err',
        }),
      ).toBe('desc');
      expect(callExtract({ detail: 'det', title: 'tit', error: 'err' })).toBe(
        'det',
      );
      expect(callExtract({ title: 'tit', error: 'err' })).toBe('tit');
      expect(callExtract({ error: 'err' })).toBe('err');
    });

    it('composes code and message from errors[0]', () => {
      expect(
        callExtract({ errors: [{ code: 88, message: 'Rate limit exceeded' }] }),
      ).toBe('code=88 Rate limit exceeded');
      expect(callExtract({ errors: [{ code: 17 }] })).toBe('code=17');
      expect(callExtract({ errors: [{ message: 'only message' }] })).toBe(
        'only message',
      );
    });

    it('returns null for empty, non-object, or detail-less bodies', () => {
      expect(callExtract(null)).toBeNull();
      expect(callExtract(undefined)).toBeNull();
      expect(callExtract('a string')).toBeNull();
      expect(callExtract(42)).toBeNull();
      expect(callExtract({})).toBeNull();
      expect(callExtract({ errors: [] })).toBeNull();
      expect(callExtract({ errors: [{}] })).toBeNull();
      expect(callExtract({ errors: 'not-an-array' })).toBeNull();
    });
  });

  describe('isUnsupportedAuthenticationError', () => {
    // Private; reach it via cast.
    const call = (status: number, body: any) =>
      (service as any).isUnsupportedAuthenticationError(status, body);

    it('returns true only for 403 with an unsupported/unknown auth detail', () => {
      expect(call(403, { detail: 'Unsupported Authentication scheme' })).toBe(
        true,
      );
      expect(
        call(403, { detail: 'Authenticating with unknown credentials' }),
      ).toBe(true);
      // case-insensitive + title fallback
      expect(call(403, { title: 'UNSUPPORTED AUTHENTICATION' })).toBe(true);
    });

    it('returns false for non-403 statuses or unrelated 403 details', () => {
      expect(call(401, { detail: 'unsupported authentication' })).toBe(false);
      expect(call(500, { detail: 'unsupported authentication' })).toBe(false);
      expect(call(403, { detail: 'some other forbidden reason' })).toBe(false);
      expect(call(403, {})).toBe(false);
      expect(call(403, null)).toBe(false);
    });
  });
});
