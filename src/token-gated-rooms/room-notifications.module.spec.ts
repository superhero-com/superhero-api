import { getQueueToken } from '@nestjs/bull';
import { RoomNotificationsModule } from './room-notifications.module';
import { RoomPreferencesService } from './services/room-preferences.service';
import { RoomEventListener } from './listeners/room-event.listener';
import { RoomNotifyProcessor } from './queues/room-notify.processor';
import { RoomMessageNotifyProcessor } from './queues/room-message-notify.processor';
import { RelaySubscriberService } from './nostr/relay-subscriber.service';
import { NotificationRedisService } from '@/notifications/services/notification-redis.service';
import { ROOM_NOTIFY_QUEUE } from './queues/room-notify.types';

/**
 * Static-metadata smoke for the Task 12 module after worker mode was removed
 * (see `deworker-plan.md`). The module is now a plain `@Module` that registers the
 * full membership-notification fan-out unconditionally in the single always-on
 * process — there is no `forRoot({ mode })` and no per-mode provider split.
 *
 * What used to be "worker/combined mode loads the listener + processors + the
 * `worker:room-notify` queue, main mode loads only RoomPreferencesService" is now a
 * single unified wiring: ALL of those providers are present and the queue is
 * registered exactly once. The relay READ path (RelaySubscriberService) and the
 * dispatch path self-gate at runtime on `isRelayConfigured` (the injected tgrConfig),
 * not on process mode, so loading them is boot-safe regardless of relay config.
 *
 * We assert the `@Module` metadata directly via `Reflect.getMetadata` rather than a
 * full Nest bootstrap, so this needs no Postgres/Redis and runs everywhere.
 */
describe('RoomNotificationsModule wiring', () => {
  const providers: any[] =
    Reflect.getMetadata('providers', RoomNotificationsModule) ?? [];
  const exportsMeta: any[] =
    Reflect.getMetadata('exports', RoomNotificationsModule) ?? [];
  const imports: any[] =
    Reflect.getMetadata('imports', RoomNotificationsModule) ?? [];

  it('registers the full membership-notification fan-out unconditionally', () => {
    // Previously worker/combined-only; now always present in the single process.
    expect(providers).toContain(RoomEventListener);
    expect(providers).toContain(RoomNotifyProcessor);
    expect(providers).toContain(RoomMessageNotifyProcessor);
    expect(providers).toContain(NotificationRedisService);
  });

  it('registers the relay READ subscriber unconditionally (self-gates at runtime)', () => {
    // Was a worker-only provider; the subscriber now loads in every process and
    // only opens a socket when isRelayConfigured(this.config) is true.
    expect(providers).toContain(RelaySubscriberService);
  });

  it('registers RoomPreferencesService (the HTTP controller read/write surface)', () => {
    // This used to be the ONLY provider in main mode; it is still always present.
    expect(providers).toContain(RoomPreferencesService);
  });

  it('exports RoomPreferencesService for the client room API controller', () => {
    expect(exportsMeta).toContain(RoomPreferencesService);
  });

  it('registers the worker:room-notify queue exactly once', () => {
    // As a plain @Module singleton the queue is registered once even though both
    // TokenGatedRoomsModule and ClientRoomApiModule import this module.
    const queueToken = getQueueToken(ROOM_NOTIFY_QUEUE);
    const queueRegistrations = imports.filter(
      (imported) =>
        imported?.module?.name === 'BullModule' &&
        (imported.providers ?? []).some(
          (provider: any) => provider?.provide === queueToken,
        ),
    );
    expect(queueRegistrations).toHaveLength(1);
  });
});
