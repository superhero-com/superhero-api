import { RelayWriterService } from '../relay-writer.service';

describe('relay membership reads', () => {
  let writer: RelayWriterService;
  let callbacks: any;
  let close: jest.Mock;
  beforeEach(() => {
    writer = new RelayWriterService({
      nostrRelayUrl: 'ws://localhost:18080',
      nostrBotNsec:
        'nsec1dwg3l5mumawgr4xq4kc6klagytkj2w4s4kd2rrthy47g3v5mwx8qwrh7sx',
      publishAckTimeoutMs: 100,
    } as any);
    close = jest.fn();
    Object.assign(writer, {
      healthy: true,
      relay: {
        connected: true,
        close: jest.fn(),
        subscribe: jest.fn((_, handlers) => {
          callbacks = handlers;
          return { close };
        }),
      },
    });
  });
  afterEach(() => {
    writer.onApplicationShutdown();
    jest.useRealTimers();
  });

  it('accepts a genuinely empty EOSE response', async () => {
    const result = writer.fetchGroupMembers('ct_room');
    await Promise.resolve();
    callbacks.oneose();
    await expect(result).resolves.toEqual(new Set());
    expect(close).toHaveBeenCalled();
  });

  it('rejects denied reads rather than reporting zero members', async () => {
    const result = writer.fetchGroupMembers('ct_room');
    await Promise.resolve();
    callbacks.onclose('auth-required: authenticate first');
    await expect(result).rejects.toThrow('auth-required');
  });

  it('rejects a timeout rather than returning partial membership', async () => {
    jest.useFakeTimers();
    const result = writer.fetchGroupMembers('ct_room');
    const assertion = expect(result).rejects.toThrow('timed out');
    await Promise.resolve();
    callbacks.onevent({ tags: [['p', 'a'.repeat(64)]] });
    await jest.advanceTimersByTimeAsync(100);
    await assertion;
    expect(close).toHaveBeenCalled();
  });
});
