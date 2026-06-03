import { ChainTransferListener } from './chain-transfer.listener';

describe('ChainTransferListener', () => {
  let registry: any;
  let notifications: any;
  let accountLabel: any;
  let listener: ChainTransferListener;
  const config = { enabled: true, minAmountAettos: 0n } as any;

  const spendTx = (overrides: Record<string, any> = {}) => ({
    type: 'SpendTx',
    hash: 'th_1',
    sender_id: 'ak_sender',
    recipient_id: 'ak_recipient',
    raw: { amount: '2000000000000000000' }, // 2 AE
    ...overrides,
  });

  beforeEach(() => {
    registry = { hasDevices: jest.fn().mockResolvedValue(true) };
    // Match the new SendOutcome return shape — the listener inspects
    // outcome.outcome, so a stale `undefined` mock would TypeError into the
    // listener's outer catch and silently swallow.
    notifications = {
      send: jest.fn().mockResolvedValue({ outcome: 'sent' }),
    };
    accountLabel = { labelFor: jest.fn().mockResolvedValue('bob.chain') };
    listener = new ChainTransferListener(
      registry,
      notifications,
      accountLabel,
      config,
    );
  });

  it('notifies the recipient on an incoming transfer when a device exists', async () => {
    await listener.onLiveTx(spendTx());
    expect(registry.hasDevices).toHaveBeenCalledWith('ak_recipient');
    expect(notifications.send).toHaveBeenCalledTimes(1);
    const [target, notification] = notifications.send.mock.calls[0];
    expect(target).toEqual({ address: 'ak_recipient' });
    expect(notification.type).toBe('incoming-transfer');
  });

  it('skips when the feature flag is disabled', async () => {
    listener = new ChainTransferListener(
      registry,
      notifications,
      accountLabel,
      {
        enabled: false,
        minAmountAettos: 0n,
      } as any,
    );
    await listener.onLiveTx(spendTx());
    expect(registry.hasDevices).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('skips non-SpendTx transactions', async () => {
    await listener.onLiveTx(spendTx({ type: 'ContractCallTx' }));
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('skips self-transfers', async () => {
    await listener.onLiveTx(
      spendTx({ sender_id: 'ak_x', recipient_id: 'ak_x' }),
    );
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('skips transfers below the anti-dust minimum', async () => {
    listener = new ChainTransferListener(
      registry,
      notifications,
      accountLabel,
      {
        enabled: true,
        minAmountAettos: 5_000_000_000_000_000_000n, // 5 AE
      } as any,
    );
    await listener.onLiveTx(spendTx()); // 2 AE
    expect(registry.hasDevices).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('does not notify when the recipient has no devices', async () => {
    registry.hasDevices.mockResolvedValue(false);
    await listener.onLiveTx(spendTx());
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('never throws back into the indexer when downstream fails', async () => {
    notifications.send.mockRejectedValue(new Error('boom'));
    await expect(listener.onLiveTx(spendTx())).resolves.toBeUndefined();
  });

  it('logs a warning when the channel reports a failed outcome (no throw)', async () => {
    notifications.send.mockResolvedValue({
      outcome: 'failed',
      channel: 'expo',
      error: 'expo down',
    });
    const warn = jest.spyOn((listener as any).logger, 'warn');
    await expect(listener.onLiveTx(spendTx())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Incoming-transfer notification failed'),
    );
  });

  it('skips dispatch when the tx hash is missing', async () => {
    await listener.onLiveTx(spendTx({ hash: undefined }) as any);
    expect(registry.hasDevices).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });
});
