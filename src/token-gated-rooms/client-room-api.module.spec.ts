import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ClientRoomApiModule } from './client-room-api.module';
import { RoomsController } from './controllers/rooms.controller';
import { RoomsQueryService } from './services/rooms-query.service';
import { RoomMuteService } from './services/room-mute.service';
import { DeviceChallengeService } from '@/notifications/services/device-challenge.service';

/**
 * Static wiring smoke for the Task 13 self-contained client room API module.
 *
 * Worker mode was removed (see `deworker-plan.md` DW1): HTTP always runs in the
 * single always-on process, so `ClientRoomApiModule` is now a plain `@Module`
 * that ALWAYS mounts its controller + read/mute services + the locally-provided
 * `DeviceChallengeService`. There is no per-mode distinction left to assert — the
 * old "main wires X / a dedicated worker wires nothing" split collapses to "the
 * controller + providers are always present".
 *
 * This reads the static `@Module` metadata via `Reflect.getMetadata` instead of a
 * full `app.init()` boot, so it asserts the unified wiring with no Postgres/Redis
 * dependency (the actual provider instantiation is exercised by the AppModule boot).
 */
function controllers(): unknown[] {
  return (
    Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ClientRoomApiModule) ?? []
  );
}

function providers(): unknown[] {
  return (
    Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ClientRoomApiModule) ?? []
  );
}

describe('ClientRoomApiModule wiring', () => {
  it('always registers the RoomsController (HTTP runs in the single process)', () => {
    expect(controllers()).toContain(RoomsController);
  });

  it('always provides the read service, mute service and the local DeviceChallengeService', () => {
    const declared = providers();
    expect(declared).toContain(RoomsQueryService);
    expect(declared).toContain(RoomMuteService);
    // Re-provided locally because NotificationsModule does not export it (see
    // the module doc-comment) — must always be present, not gated by any mode.
    expect(declared).toContain(DeviceChallengeService);
  });
});
