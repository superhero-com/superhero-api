import { InvitationClaimedListener } from './invitation-claimed.listener';

describe('InvitationClaimedListener', () => {
  let registry: any;
  let notifications: any;
  let accountLabel: any;
  let listener: InvitationClaimedListener;
  const config = { enabled: true } as any;

  const payload = (overrides: Record<string, any> = {}) => ({
    invitationId: 'inv1',
    inviterAddress: 'ak_inviter',
    claimerAddress: 'ak_claimer',
    amountAe: '5',
    txHash: 'th_claim',
    ...overrides,
  });

  beforeEach(() => {
    registry = { hasDevices: jest.fn().mockResolvedValue(true) };
    notifications = { send: jest.fn().mockResolvedValue({ outcome: 'sent' }) };
    accountLabel = { labelFor: jest.fn().mockResolvedValue('claimer.chain') };
    listener = new InvitationClaimedListener(
      registry,
      notifications,
      accountLabel,
      config,
    );
  });

  it('notifies the inviter when they have a device', async () => {
    await listener.onClaimed(payload());
    expect(registry.hasDevices).toHaveBeenCalledWith('ak_inviter');
    const [target, notification] = notifications.send.mock.calls[0];
    expect(target).toEqual({ address: 'ak_inviter' });
    expect(notification.type).toBe('invitation-claimed');
  });

  it('skips when the feature flag is disabled', async () => {
    listener = new InvitationClaimedListener(
      registry,
      notifications,
      accountLabel,
      { enabled: false } as any,
    );
    await listener.onClaimed(payload());
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('skips a self-claim (inviter === claimer)', async () => {
    await listener.onClaimed(payload({ claimerAddress: 'ak_inviter' }));
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('skips when required fields are missing', async () => {
    await listener.onClaimed(payload({ txHash: undefined }));
    expect(registry.hasDevices).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('short-circuits before label resolution when the inviter has no device', async () => {
    registry.hasDevices.mockResolvedValue(false);
    await listener.onClaimed(payload());
    expect(accountLabel.labelFor).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('never throws back into the emitter even if send rejects', async () => {
    notifications.send.mockRejectedValue(new Error('boom'));
    await expect(listener.onClaimed(payload())).resolves.toBeUndefined();
  });
});
