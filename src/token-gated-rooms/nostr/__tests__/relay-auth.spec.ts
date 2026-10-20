import type { Relay } from 'nostr-tools';
import { authenticateRelay } from '../relay-auth';

describe('NIP-42 authentication', () => {
  afterEach(() => jest.useRealTimers());

  it('waits for a challenge that arrives after the websocket opens', async () => {
    jest.useFakeTimers();
    const auth = jest
      .fn()
      .mockRejectedValueOnce(
        new Error("can't perform auth, no challenge was received"),
      )
      .mockResolvedValue('authenticated');
    const sign = jest.fn();
    const pending = authenticateRelay(
      { connected: true, auth } as unknown as Relay,
      sign,
      1000,
    );
    await jest.advanceTimersByTimeAsync(25);
    await pending;
    expect(auth).toHaveBeenCalledTimes(2);
    expect(auth).toHaveBeenLastCalledWith(sign);
  });

  it('propagates rejected authentication instead of accepting an unauthenticated connection', async () => {
    const auth = jest
      .fn()
      .mockRejectedValue(new Error('restricted: invalid signature'));
    await expect(
      authenticateRelay(
        { connected: true, auth } as unknown as Relay,
        jest.fn(),
        1000,
      ),
    ).rejects.toThrow('invalid signature');
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it('bounds missing challenges and clears timers', async () => {
    jest.useFakeTimers();
    const auth = jest
      .fn()
      .mockRejectedValue(new Error('no challenge was received'));
    const result = authenticateRelay(
      { connected: true, auth } as unknown as Relay,
      jest.fn(),
      100,
    );
    const assertion = expect(result).rejects.toThrow('timed out');
    await jest.advanceTimersByTimeAsync(100);
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
  });
});
