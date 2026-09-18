/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * The affiliation dashboards join wallet address to X handle, follower count
 * and payout. The guard's job is to make that join unreachable without the
 * operator key — including when the key was never configured, which must lock
 * the dashboards rather than open them.
 */
import { ExecutionContext } from '@nestjs/common';

const KEY = 'k'.repeat(32);

const contextFor = (
  request: Record<string, any>,
  response: Record<string, any> = {},
): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: {}, query: {}, ...request }),
      getResponse: () => response,
    }),
  }) as any;

const guardWithKey = async (key: string) => {
  let Guard: any;
  await jest.isolateModulesAsync(async () => {
    jest.doMock('@/configs/constants', () => ({
      AFFILIATION_ANALYTICS_API_KEY: key,
      AFFILIATION_ANALYTICS_MIN_KEY_LENGTH: 16,
    }));
    ({
      AffiliationAnalyticsGuard: Guard,
    } = require('./affiliation-analytics.guard'));
  });
  return new Guard();
};

describe('AffiliationAnalyticsGuard', () => {
  it('rejects a request carrying no key', async () => {
    const guard = await guardWithKey(KEY);
    expect(() => guard.canActivate(contextFor({}))).toThrow(
      /valid operator key is required/i,
    );
  });

  it('rejects a wrong key of the same length', async () => {
    const guard = await guardWithKey(KEY);
    expect(() =>
      guard.canActivate(
        contextFor({ headers: { 'x-api-key': 'x'.repeat(32) } }),
      ),
    ).toThrow(/valid operator key is required/i);
  });

  it('fails closed when the server key is unset', async () => {
    const guard = await guardWithKey('');
    // Even presenting the empty string must not get in.
    expect(() =>
      guard.canActivate(contextFor({ headers: { 'x-api-key': '' } })),
    ).toThrow(/not configured/i);
  });

  it('fails closed when the server key is too short to be a secret', async () => {
    const short = 'abc123';
    const guard = await guardWithKey(short);
    expect(() =>
      guard.canActivate(contextFor({ headers: { 'x-api-key': short } })),
    ).toThrow(/not configured/i);
  });

  it('accepts the key in the x-api-key header', async () => {
    const guard = await guardWithKey(KEY);
    expect(
      guard.canActivate(contextFor({ headers: { 'x-api-key': KEY } })),
    ).toBe(true);
  });

  it('accepts the key as a bearer token', async () => {
    const guard = await guardWithKey(KEY);
    expect(
      guard.canActivate(
        contextFor({ headers: { authorization: `Bearer ${KEY}` } }),
      ),
    ).toBe(true);
  });

  it('accepts the key in the query string and trades it for a cookie', async () => {
    const guard = await guardWithKey(KEY);
    const cookie = jest.fn();
    expect(
      guard.canActivate(contextFor({ query: { key: KEY } }, { cookie })),
    ).toBe(true);
    expect(cookie).toHaveBeenCalledWith(
      'sh_affiliation_analytics',
      KEY,
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
  });

  it('marks the cookie Secure only behind TLS', async () => {
    const guard = await guardWithKey(KEY);

    const plain = jest.fn();
    guard.canActivate(contextFor({ query: { key: KEY } }, { cookie: plain }));
    expect(plain).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ secure: false }),
    );

    const tls = jest.fn();
    guard.canActivate(
      contextFor(
        { query: { key: KEY }, headers: { 'x-forwarded-proto': 'https' } },
        { cookie: tls },
      ),
    );
    expect(tls).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ secure: true }),
    );
  });

  it('accepts the session cookie on a later request with no key in the URL', async () => {
    const guard = await guardWithKey(KEY);
    expect(
      guard.canActivate(
        contextFor({
          headers: { cookie: `other=1; sh_affiliation_analytics=${KEY}` },
        }),
      ),
    ).toBe(true);
  });

  it('rejects a forged cookie', async () => {
    const guard = await guardWithKey(KEY);
    expect(() =>
      guard.canActivate(
        contextFor({
          headers: { cookie: `sh_affiliation_analytics=${'x'.repeat(32)}` },
        }),
      ),
    ).toThrow(/valid operator key is required/i);
  });

  it('does not mistake a cookie whose name merely ends with the same suffix', async () => {
    const guard = await guardWithKey(KEY);
    expect(() =>
      guard.canActivate(
        contextFor({
          headers: { cookie: `evil_sh_affiliation_analytics=${KEY}` },
        }),
      ),
    ).toThrow(/valid operator key is required/i);
  });
});
