/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * The affiliation dashboards join wallet address to X handle, follower count
 * and payout. The guard's job is to make that join unreachable without the
 * operator credentials — including when they were never configured, which must
 * lock the dashboards rather than open them.
 */
import { ExecutionContext } from '@nestjs/common';

const USER = 'admin';
const PASSWORD = 'p'.repeat(32);

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

const contextFor = (
  headers: Record<string, string> = {},
  response: Record<string, any> = { setHeader: jest.fn() },
): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
      getResponse: () => response,
    }),
  }) as any;

const guardWith = async (user: string, password: string) => {
  let Guard: any;
  await jest.isolateModulesAsync(async () => {
    jest.doMock('@/configs/constants', () => ({
      AFFILIATION_ANALYTICS_USER: user,
      AFFILIATION_ANALYTICS_PASSWORD: password,
      AFFILIATION_ANALYTICS_MIN_PASSWORD_LENGTH: 16,
    }));
    ({
      AffiliationAnalyticsGuard: Guard,
    } = require('./affiliation-analytics.guard'));
  });
  return new Guard();
};

describe('AffiliationAnalyticsGuard', () => {
  describe('when configured', () => {
    it('accepts the correct credentials', async () => {
      const guard = await guardWith(USER, PASSWORD);
      expect(
        guard.canActivate(contextFor({ authorization: basic(USER, PASSWORD) })),
      ).toBe(true);
    });

    it('rejects a request with no Authorization header', async () => {
      const guard = await guardWith(USER, PASSWORD);
      expect(() => guard.canActivate(contextFor({}))).toThrow(
        /authentication required/i,
      );
    });

    it('challenges so the browser shows its credential prompt', async () => {
      const guard = await guardWith(USER, PASSWORD);
      const setHeader = jest.fn();
      expect(() => guard.canActivate(contextFor({}, { setHeader }))).toThrow();
      expect(setHeader).toHaveBeenCalledWith(
        'WWW-Authenticate',
        expect.stringContaining('Basic realm='),
      );
    });

    it('rejects a wrong password', async () => {
      const guard = await guardWith(USER, PASSWORD);
      expect(() =>
        guard.canActivate(
          contextFor({ authorization: basic(USER, 'x'.repeat(32)) }),
        ),
      ).toThrow(/authentication required/i);
    });

    it('rejects a wrong username even with the right password', async () => {
      const guard = await guardWith(USER, PASSWORD);
      expect(() =>
        guard.canActivate(
          contextFor({ authorization: basic('someone-else', PASSWORD) }),
        ),
      ).toThrow(/authentication required/i);
    });

    it('rejects a non-Basic scheme carrying the password', async () => {
      const guard = await guardWith(USER, PASSWORD);
      expect(() =>
        guard.canActivate(contextFor({ authorization: `Bearer ${PASSWORD}` })),
      ).toThrow(/authentication required/i);
    });

    it('rejects a malformed header with no colon in the payload', async () => {
      const guard = await guardWith(USER, PASSWORD);
      const encoded = Buffer.from('no-colon-here', 'utf8').toString('base64');
      expect(() =>
        guard.canActivate(contextFor({ authorization: `Basic ${encoded}` })),
      ).toThrow(/authentication required/i);
    });

    it('accepts a scheme name in any case, as RFC 7617 requires', async () => {
      const guard = await guardWith(USER, PASSWORD);
      const encoded = Buffer.from(`${USER}:${PASSWORD}`, 'utf8').toString(
        'base64',
      );
      expect(
        guard.canActivate(contextFor({ authorization: `bAsIc ${encoded}` })),
      ).toBe(true);
    });

    it('keeps a password that contains colons intact', async () => {
      const colonPassword = 'a:b:c:'.repeat(6);
      const guard = await guardWith(USER, colonPassword);
      expect(
        guard.canActivate(
          contextFor({ authorization: basic(USER, colonPassword) }),
        ),
      ).toBe(true);
    });
  });

  describe('when not configured', () => {
    it('locks the dashboards when the password is unset', async () => {
      const guard = await guardWith(USER, '');
      expect(() =>
        guard.canActivate(contextFor({ authorization: basic(USER, '') })),
      ).toThrow(/not configured/i);
    });

    it('locks the dashboards when the password is too short to be a secret', async () => {
      const guard = await guardWith(USER, 'abc123');
      expect(() =>
        guard.canActivate(contextFor({ authorization: basic(USER, 'abc123') })),
      ).toThrow(/not configured/i);
    });

    it('does NOT challenge when unconfigured, so the browser cannot loop', async () => {
      // A 401 challenge here would make the browser prompt, reject whatever is
      // typed, and prompt again forever — no credential can satisfy an unset
      // password. The operator must see the misconfiguration instead.
      const guard = await guardWith(USER, '');
      const setHeader = jest.fn();
      expect(() => guard.canActivate(contextFor({}, { setHeader }))).toThrow();
      expect(setHeader).not.toHaveBeenCalled();
    });

    it('names the variable the operator has to set', async () => {
      const guard = await guardWith(USER, '');
      expect(() => guard.canActivate(contextFor({}))).toThrow(
        /AFFILIATION_ANALYTICS_PASSWORD/,
      );
    });
  });
});
