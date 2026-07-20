import { NotificationsGateway } from './notifications.gateway';

describe('NotificationsGateway', () => {
  let sessions: any;
  let gateway: NotificationsGateway;
  const config = {
    socketMaxConnsPerAddress: 2,
    // High enough that no existing test's handful of calls from the same
    // mock IP ever trips it; the handshake-cap behavior itself is exercised
    // by its own dedicated gateway instance below.
    socketMaxHandshakesPerIpPerMinute: 100,
  } as any;

  const makeClient = (token?: string) => ({
    handshake: {
      auth: token ? { token } : {},
      headers: {},
      address: '127.0.0.1',
    },
    data: {} as any,
    connected: true,
    join: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
  });

  beforeEach(() => {
    sessions = { resolve: jest.fn() };
    gateway = new NotificationsGateway(sessions, config);
  });

  it('disconnects a socket with no session token', async () => {
    const client = makeClient();
    await gateway.handleConnection(client as any);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('joins the proven address room on a valid session', async () => {
    sessions.resolve.mockResolvedValue('ak_owner');
    const client = makeClient('tok');
    await gateway.handleConnection(client as any);
    expect(client.join).toHaveBeenCalledWith('ak_owner');
    expect(client.data.address).toBe('ak_owner');
  });

  it('accepts the bearer token from the Authorization header', async () => {
    sessions.resolve.mockResolvedValue('ak_owner');
    const client = {
      handshake: {
        auth: {},
        headers: { authorization: 'Bearer tok' },
        address: '127.0.0.1',
      },
      data: {} as any,
      connected: true,
      join: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };
    await gateway.handleConnection(client as any);
    expect(sessions.resolve).toHaveBeenCalledWith('tok');
    expect(client.join).toHaveBeenCalledWith('ak_owner');
  });

  it('releases the slot and disconnects when join() rejects', async () => {
    sessions.resolve.mockResolvedValue('ak_owner');
    const failing = makeClient('tok');
    failing.join.mockRejectedValue(new Error('adapter down'));
    await gateway.handleConnection(failing as any);
    expect(failing.disconnect).toHaveBeenCalledWith(true);

    // The failed connection must NOT have permanently consumed a cap slot:
    // with cap=2, two fresh sockets should still both be accepted afterwards.
    const a = makeClient('tok');
    const b = makeClient('tok');
    await gateway.handleConnection(a as any);
    await gateway.handleConnection(b as any);
    expect(a.join).toHaveBeenCalledWith('ak_owner');
    expect(b.join).toHaveBeenCalledWith('ak_owner');
  });

  it('does not double-release the slot when a failed join() is followed by handleDisconnect (as Nest/socket.io really does)', async () => {
    // Regression: `client.disconnect(true)` — called in the join()-failure
    // catch block — is not a no-op in production. Socket.io emits the socket's
    // 'disconnect' event, which Nest wires straight to `handleDisconnect`. This
    // mock client's `disconnect` is a bare jest.fn(), so it does NOT trigger
    // that automatically; we invoke `handleDisconnect` explicitly here to
    // reproduce what the real framework does — the plain
    // "releases the slot and disconnects when join() rejects" test above
    // cannot see this bug because it never simulates that second call.
    sessions.resolve.mockResolvedValue('ak_owner');

    const a = makeClient('tok'); // succeeds — the one REAL live connection
    await gateway.handleConnection(a as any);

    const failing = makeClient('tok'); // fails to join, under the cap=2
    failing.join.mockRejectedValue(new Error('adapter down'));
    await gateway.handleConnection(failing as any);
    expect(failing.disconnect).toHaveBeenCalledWith(true);
    // Simulate the real disconnect->handleDisconnect wiring for the failed
    // socket. If `client.data.address` were stamped before the join attempt,
    // this would release the slot A SECOND TIME (once in the catch block,
    // once here), undercounting `a`'s still-live connection.
    gateway.handleDisconnect(failing as any);

    // With the undercount bug, the map would (wrongly) think 0 sockets are
    // connected, so cap=2 would let in 2 MORE — a total of 3 concurrent
    // sockets for one address instead of the configured cap of 2. Correctly
    // accounted, exactly one more slot is available (a is still connected).
    const b = makeClient('tok');
    const c = makeClient('tok');
    await gateway.handleConnection(b as any);
    await gateway.handleConnection(c as any);
    expect(b.join).toHaveBeenCalledWith('ak_owner'); // the one remaining slot
    expect(c.disconnect).toHaveBeenCalledWith(true); // cap correctly enforced
    expect(c.join).not.toHaveBeenCalled();
  });

  it('rejects connections beyond the per-address cap', async () => {
    sessions.resolve.mockResolvedValue('ak_owner');
    const a = makeClient('tok');
    const b = makeClient('tok');
    const c = makeClient('tok');
    await gateway.handleConnection(a as any);
    await gateway.handleConnection(b as any);
    await gateway.handleConnection(c as any); // cap is 2
    expect(c.disconnect).toHaveBeenCalledWith(true);
    expect(c.join).not.toHaveBeenCalled();
  });

  it('frees a slot on disconnect so a later connection is accepted', async () => {
    sessions.resolve.mockResolvedValue('ak_owner');
    const a = makeClient('tok');
    const b = makeClient('tok');
    await gateway.handleConnection(a as any);
    await gateway.handleConnection(b as any);
    gateway.handleDisconnect(a as any);

    const c = makeClient('tok');
    await gateway.handleConnection(c as any);
    expect(c.join).toHaveBeenCalledWith('ak_owner');
  });

  it('aborts without joining, counting, or double-disconnecting when the socket drops mid-resolve', async () => {
    // Regression: the socket's own 'disconnect' event can fire WHILE
    // handleConnection is still awaiting the session lookup. socket.io/Nest
    // already tore the connection down at that point (no `handleDisconnect`
    // call from us to make, and calling `disconnect()` again would be wrong);
    // resuming as if the socket were still alive would take a permanent slot
    // no later disconnect event will ever release.
    const client = makeClient('tok');
    sessions.resolve.mockImplementation(async () => {
      client.connected = false; // simulate the drop happening during the await
      return 'ak_owner';
    });

    await gateway.handleConnection(client as any);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();

    // No slot was consumed by the aborted attempt: a fresh cap-worth of
    // connections must still all succeed afterwards.
    sessions.resolve.mockResolvedValue('ak_owner');
    const a = makeClient('tok');
    const b = makeClient('tok');
    await gateway.handleConnection(a as any);
    await gateway.handleConnection(b as any);
    expect(a.join).toHaveBeenCalledWith('ak_owner');
    expect(b.join).toHaveBeenCalledWith('ak_owner');
  });

  it('rejects a handshake burst from the same IP before ever resolving a session', async () => {
    const capped = new NotificationsGateway(sessions, {
      socketMaxConnsPerAddress: 100,
      socketMaxHandshakesPerIpPerMinute: 2,
    } as any);
    sessions.resolve.mockResolvedValue('ak_owner');

    const a = makeClient('tok');
    const b = makeClient('tok');
    const c = makeClient('tok'); // 3rd attempt from the same IP within the window
    await capped.handleConnection(a as any);
    await capped.handleConnection(b as any);
    await capped.handleConnection(c as any);

    expect(a.join).toHaveBeenCalledWith('ak_owner');
    expect(b.join).toHaveBeenCalledWith('ak_owner');
    expect(c.disconnect).toHaveBeenCalledWith(true);
    expect(c.join).not.toHaveBeenCalled();
    // The capped attempt never even reached the session lookup.
    expect(sessions.resolve).toHaveBeenCalledTimes(2);
  });

  it('tracks handshake attempts per IP independently', async () => {
    const capped = new NotificationsGateway(sessions, {
      socketMaxConnsPerAddress: 100,
      socketMaxHandshakesPerIpPerMinute: 1,
    } as any);
    sessions.resolve.mockResolvedValue('ak_owner');

    const fromIpOne = {
      ...makeClient('tok'),
      handshake: { auth: { token: 'tok' }, headers: {}, address: '10.0.0.1' },
    };
    const alsoIpOne = {
      ...makeClient('tok'),
      handshake: { auth: { token: 'tok' }, headers: {}, address: '10.0.0.1' },
    };
    const fromIpTwo = {
      ...makeClient('tok'),
      handshake: { auth: { token: 'tok' }, headers: {}, address: '10.0.0.2' },
    };

    await capped.handleConnection(fromIpOne as any);
    await capped.handleConnection(alsoIpOne as any); // over cap=1 for this IP
    await capped.handleConnection(fromIpTwo as any); // a fresh IP, still under cap

    expect(fromIpOne.join).toHaveBeenCalledWith('ak_owner');
    expect(alsoIpOne.disconnect).toHaveBeenCalledWith(true);
    expect(fromIpTwo.join).toHaveBeenCalledWith('ak_owner');
  });

  it('emits a feed item only to the recipient room', () => {
    const emit = jest.fn();
    (gateway as any).server = { to: jest.fn(() => ({ emit })) };
    const item: any = { id: 1 };
    gateway.emitToAddress('ak_owner', item);
    expect((gateway as any).server.to).toHaveBeenCalledWith('ak_owner');
    expect(emit).toHaveBeenCalledWith('notification', item);
  });

  it('emits the unread count to the recipient room', () => {
    const emit = jest.fn();
    (gateway as any).server = { to: jest.fn(() => ({ emit })) };
    gateway.emitUnreadCount('ak_owner', 5);
    expect(emit).toHaveBeenCalledWith('unread-count', { count: 5 });
  });
});

describe('NotificationsGateway (behind a trusted reverse proxy)', () => {
  const ORIGINAL_TRUST_PROXY = process.env.TRUST_PROXY;

  afterEach(() => {
    if (ORIGINAL_TRUST_PROXY === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = ORIGINAL_TRUST_PROXY;
    }
    jest.resetModules();
  });

  it('keys the per-IP handshake cap off the real client IP (X-Forwarded-For), not the shared proxy peer', async () => {
    // Regression: `handshake.address` is engine.io's raw TCP peer, which is
    // the reverse proxy itself in this topology — every real client shares
    // it. Without resolving through TRUST_PROXY/X-Forwarded-For, the second
    // (distinct) client below would wrongly collide with the first in the
    // same per-IP bucket and get capped.
    jest.resetModules();
    process.env.TRUST_PROXY = '1';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const gatewayModule = require('./notifications.gateway');
    const Gateway = gatewayModule.NotificationsGateway;

    const sessionsBehindProxy = {
      resolve: jest.fn().mockResolvedValue('ak_owner'),
    };
    const gatewayBehindProxy = new Gateway(sessionsBehindProxy, {
      socketMaxConnsPerAddress: 100,
      socketMaxHandshakesPerIpPerMinute: 1,
    });

    const clientFor = (realClientIp: string) => ({
      handshake: {
        auth: { token: 'tok' },
        headers: { 'x-forwarded-for': realClientIp },
        address: '10.0.0.1', // the SAME reverse-proxy peer for every client
      },
      data: {} as any,
      connected: true,
      join: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    });

    const clientA = clientFor('1.1.1.1');
    const clientB = clientFor('2.2.2.2'); // a different real client, same proxy peer

    await gatewayBehindProxy.handleConnection(clientA);
    await gatewayBehindProxy.handleConnection(clientB);

    expect(clientA.join).toHaveBeenCalledWith('ak_owner');
    expect(clientB.join).toHaveBeenCalledWith('ak_owner');
    expect(clientB.disconnect).not.toHaveBeenCalled();
  });
});
