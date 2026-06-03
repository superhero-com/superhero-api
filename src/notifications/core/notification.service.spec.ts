import { NotificationService } from './notification.service';
import { NotificationChannel } from './notification-channel.interface';
import { AppNotification } from './notification.interface';
import { Notifiable } from './notifiable.interface';
import { NotificationPreferencesService } from '../services/notification-preferences.service';

function makeNotification(
  channels: AppNotification['type'][] | any,
): AppNotification {
  return {
    type: 'test',
    title: 'Test',
    description: 'Test notification.',
    via: () => channels,
    dedupKey: (n: Notifiable) => `k:${n.address}`,
    toExpo: () => ({ title: 't', body: 'b' }),
  };
}

/** Default-enabled mock; tests that need to verify the chokepoint pass `false`. */
function mockPrefs(enabled = true): NotificationPreferencesService {
  return {
    isEnabled: jest.fn().mockResolvedValue(enabled),
  } as unknown as NotificationPreferencesService;
}

describe('NotificationService', () => {
  const notifiable: Notifiable = { address: 'ak_test' as any };

  it("returns {outcome:'sent'} when the channel succeeds", async () => {
    const expo: NotificationChannel = {
      name: 'expo',
      send: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NotificationService([expo], mockPrefs());

    const result = await service.send(notifiable, makeNotification(['expo']));

    expect(result).toEqual({ outcome: 'sent' });
    expect(expo.send).toHaveBeenCalledTimes(1);
    expect(expo.send).toHaveBeenCalledWith(notifiable, expect.any(Object));
  });

  it("returns {outcome:'failed'} (does not throw) when no channel is registered", async () => {
    const expo: NotificationChannel = {
      name: 'expo',
      send: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NotificationService([expo], mockPrefs());

    const result = await service.send(
      notifiable,
      makeNotification(['database']),
    );

    expect(result.outcome).toBe('failed');
    expect(expo.send).not.toHaveBeenCalled();
  });

  it("returns {outcome:'failed'} with the channel name when a channel rejects", async () => {
    const failing: NotificationChannel = {
      name: 'expo',
      send: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const service = new NotificationService([failing], mockPrefs());

    const result = await service.send(notifiable, makeNotification(['expo']));

    expect(result).toMatchObject({
      outcome: 'failed',
      channel: 'expo',
      error: 'boom',
    });
    expect(failing.send).toHaveBeenCalled();
  });

  it('isolates a failing channel but still reports failed if any rejects', async () => {
    const failing: NotificationChannel = {
      name: 'expo',
      send: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const ok: NotificationChannel = {
      name: 'database',
      send: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NotificationService([failing, ok], mockPrefs());

    const result = await service.send(
      notifiable,
      makeNotification(['expo', 'database']),
    );

    expect(result.outcome).toBe('failed');
    expect(failing.send).toHaveBeenCalled();
    expect(ok.send).toHaveBeenCalled();
  });

  it("returns {outcome:'no-channel'} when via() yields no channels", async () => {
    const expo: NotificationChannel = {
      name: 'expo',
      send: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NotificationService([expo], mockPrefs());

    const result = await service.send(notifiable, makeNotification([]));
    expect(result).toEqual({ outcome: 'no-channel' });
    expect(expo.send).not.toHaveBeenCalled();
  });

  it("short-circuits with {outcome:'opted-out'} when the user has disabled this type", async () => {
    const expo: NotificationChannel = {
      name: 'expo',
      send: jest.fn().mockResolvedValue(undefined),
    };
    const prefs = mockPrefs(false);
    const service = new NotificationService([expo], prefs);

    const result = await service.send(notifiable, makeNotification(['expo']));

    expect(result).toEqual({ outcome: 'opted-out' });
    expect(prefs.isEnabled).toHaveBeenCalledWith('ak_test', 'test');
    expect(expo.send).not.toHaveBeenCalled();
  });
});
