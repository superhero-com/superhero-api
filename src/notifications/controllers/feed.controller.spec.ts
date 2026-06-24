import { FeedController } from './feed.controller';

describe('FeedController', () => {
  let challenges: any;
  let sessions: any;
  let feed: any;
  let gateway: any;
  let controller: FeedController;
  const config = { feedMaxPageSize: 50 } as any;
  const address = 'ak_owner';

  beforeEach(() => {
    challenges = {
      issue: jest.fn(),
      verifyAndConsumeForSession: jest.fn().mockResolvedValue(undefined),
    };
    sessions = {
      mint: jest.fn(),
      revoke: jest.fn().mockResolvedValue(undefined),
    };
    feed = {
      listFor: jest.fn(),
      unreadCount: jest.fn(),
      markRead: jest.fn(),
    };
    gateway = { emitUnreadCount: jest.fn() };
    controller = new FeedController(
      challenges,
      sessions,
      feed,
      gateway,
      config,
    );
  });

  it('issues a challenge for the path address', async () => {
    challenges.issue.mockResolvedValue({ nonce: 'n', expiresAt: new Date() });
    await controller.requestChallenge(address);
    expect(challenges.issue).toHaveBeenCalledWith(address);
  });

  it('verifies the signature then mints a session', async () => {
    const expiresAt = new Date('2026-01-08T00:00:00.000Z');
    sessions.mint.mockResolvedValue({ token: 'tok', expiresAt });
    const out = await controller.createSession(address, {
      nonce: 'n',
      signature: 'sg_x',
    });
    expect(challenges.verifyAndConsumeForSession).toHaveBeenCalledWith(
      'n',
      address,
      'sg_x',
    );
    expect(out).toEqual({ token: 'tok', expiresAt: expiresAt.toISOString() });
  });

  it('revokes the calling session using the bearer from the request', async () => {
    const request: any = { headers: { authorization: 'Bearer tok-123' } };
    const out = await controller.revokeSession(address, request);
    expect(sessions.revoke).toHaveBeenCalledWith('tok-123');
    expect(out).toEqual({ ok: true });
  });

  it('maps a feed page and clamps the limit to the configured max', async () => {
    feed.listFor.mockResolvedValue({
      items: [
        {
          id: 3,
          type: 'incoming-transfer',
          title: 't',
          body: 'b',
          data: null,
          read_at: null,
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
      nextCursor: null,
    });

    const out = await controller.list(address, undefined, '9999');
    expect(feed.listFor).toHaveBeenCalledWith(address, {
      cursor: undefined,
      limit: 50,
    });
    expect(out.items[0].id).toBe(3);
    expect(out.nextCursor).toBeNull();
  });

  it('passes a positive cursor through and a bad one as undefined', async () => {
    feed.listFor.mockResolvedValue({ items: [], nextCursor: null });
    await controller.list(address, '12', '10');
    expect(feed.listFor).toHaveBeenCalledWith(address, {
      cursor: 12,
      limit: 10,
    });
    await controller.list(address, 'abc', '10');
    expect(feed.listFor).toHaveBeenLastCalledWith(address, {
      cursor: undefined,
      limit: 10,
    });
  });

  it('returns the unread count', async () => {
    feed.unreadCount.mockResolvedValue(4);
    await expect(controller.unreadCount(address)).resolves.toEqual({
      count: 4,
    });
  });

  it('marks read and pushes the new unread count over the socket', async () => {
    feed.markRead.mockResolvedValue(1);
    const out = await controller.markRead(address, { ids: [5, 6] });
    expect(feed.markRead).toHaveBeenCalledWith(address, [5, 6]);
    expect(gateway.emitUnreadCount).toHaveBeenCalledWith(address, 1);
    expect(out).toEqual({ count: 1 });
  });

  it('still returns the count when the live emit throws (best-effort)', async () => {
    feed.markRead.mockResolvedValue(2);
    gateway.emitUnreadCount.mockImplementation(() => {
      throw new Error('server not ready');
    });
    // The DB write is already committed, so a socket failure must not surface
    // as a 500 — the controller swallows it and returns the count.
    await expect(controller.markRead(address, { ids: [5] })).resolves.toEqual({
      count: 2,
    });
  });
});
