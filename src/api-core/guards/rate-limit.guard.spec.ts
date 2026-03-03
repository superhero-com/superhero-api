import { ExecutionContext } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.guard';

describe('RateLimitGuard', () => {
  it('uses the express-resolved ip instead of trusting x-forwarded-for', () => {
    const guard = new RateLimitGuard();
    const request = {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      route: { path: '/profile/x-posting-reward/recheck' },
      path: '/profile/x-posting-reward/recheck',
      socket: { remoteAddress: '127.0.0.1' },
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as ExecutionContext;

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);

    const internalMap = (guard as any).rateLimitMap as Map<string, unknown>;
    const keys = Array.from(internalMap.keys());
    expect(keys).toContain('10.0.0.1:/profile/x-posting-reward/recheck');
    expect(keys.some((key) => key.includes('203.0.113.10'))).toBe(false);
  });
});
