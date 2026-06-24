import { UnauthorizedException } from '@nestjs/common';
import { FeedSessionGuard } from './feed-session.guard';

describe('FeedSessionGuard', () => {
  let sessions: any;
  let guard: FeedSessionGuard;

  beforeEach(() => {
    sessions = { resolve: jest.fn() };
    guard = new FeedSessionGuard(sessions);
  });

  const ctx = (headers: any, params: any) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers, params }) }),
    }) as any;

  it('allows when the bearer resolves to the path address', async () => {
    sessions.resolve.mockResolvedValue('ak_owner');
    await expect(
      guard.canActivate(
        ctx({ authorization: 'Bearer tok' }, { address: 'ak_owner' }),
      ),
    ).resolves.toBe(true);
    expect(sessions.resolve).toHaveBeenCalledWith('tok');
  });

  it('rejects a missing Authorization header', async () => {
    await expect(
      guard.canActivate(ctx({}, { address: 'ak_owner' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a non-Bearer scheme', async () => {
    await expect(
      guard.canActivate(
        ctx({ authorization: 'Basic abc' }, { address: 'ak_owner' }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unknown/expired token', async () => {
    sessions.resolve.mockResolvedValue(null);
    await expect(
      guard.canActivate(
        ctx({ authorization: 'Bearer tok' }, { address: 'ak_owner' }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the session owns a different address than the path', async () => {
    sessions.resolve.mockResolvedValue('ak_attacker');
    await expect(
      guard.canActivate(
        ctx({ authorization: 'Bearer tok' }, { address: 'ak_victim' }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
