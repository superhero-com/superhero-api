import 'reflect-metadata';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { TokenGatedRoomsModule } from './token-gated-rooms.module';
import { isRelayConfigured } from './config/tgr.config';
import { PublishNip29Module } from './queues/publish-nip29.module';
import { RoomNotificationsModule } from './room-notifications.module';
import { ClientRoomApiModule } from './client-room-api.module';
import { TgrObservabilityModule } from './observability/tgr-observability.module';
import { IdentityService } from './services/identity.service';
import { IdentityBackfillService } from './services/identity-backfill.service';
import { EligibilityService } from './services/eligibility.service';
import { RoomAdminsService } from './services/room-admins.service';
import { RelayAdminHealthService } from './nostr/relay-admin-health';
import { RoomBackfillService } from './services/room-backfill.service';
import { RoomBackfillProcessor } from './queues/room-backfill.processor';
import { MembershipSyncService } from './services/membership-sync.service';
import { ReconciliationService } from './services/reconciliation.service';
import { ReorgEvictionService } from './services/reorg-eviction.service';
import { ReconcileProcessor } from './queues/reconcile.processor';

/**
 * Static wiring assertions for the token-gated-rooms module.
 *
 * Worker mode is gone (see `deworker-plan.md`): there is no longer a
 * `main`/`worker`/`combined` trichotomy and no `TokenGatedRoomsModule.forRoot({mode})`.
 * The module is a PLAIN `@Module` that registers EVERY provider once — the
 * chain-driven indexing listeners (eligibility, identity backfill), the relay
 * actuators (writer/subscriber consumers + backfill/reconcile/membership-sync), and
 * the HTTP read API — and exports the public providers unconditionally. The relay
 * actuators self-enable at runtime iff a relay is configured (`isRelayConfigured`);
 * un-configured they construct but stay dormant, so the public API + indexer still
 * boot.
 *
 * The old boot smoke asserted which providers loaded per process mode (e.g.
 * `EligibilityService` main-only, `RoomAdminsService`/relay actuators worker-only,
 * `validateTgrEnv` fail-fast in worker/combined). Those distinctions no longer exist.
 * To keep these assertions infra-free (the old version `app.init()`-booted a real
 * Postgres + Redis), the unified wiring is asserted via the static `@Module`
 * metadata (`Reflect.getMetadata`) instead of a live Nest container.
 */
describe('TokenGatedRoomsModule wiring', () => {
  const providers: unknown[] =
    Reflect.getMetadata('providers', TokenGatedRoomsModule) ?? [];
  const imports: unknown[] =
    Reflect.getMetadata('imports', TokenGatedRoomsModule) ?? [];
  const exports: unknown[] =
    Reflect.getMetadata('exports', TokenGatedRoomsModule) ?? [];

  it('is a plain @Module — no forRoot factory (mode trichotomy removed)', () => {
    // The `main`/`worker`/`combined` split + the per-mode `forRoot({mode})` factory
    // are gone. Asserting the absence guards against a regression that reintroduces
    // a mode-conditional wiring path.
    expect(
      (TokenGatedRoomsModule as unknown as { forRoot?: unknown }).forRoot,
    ).toBeUndefined();
  });

  it('registers the indexing listeners unconditionally (were main-only)', () => {
    // Previously `processRunsMain`-gated (loaded only in main/combined). In the
    // single always-on process they always load.
    expect(providers).toContain(IdentityService);
    expect(providers).toContain(IdentityBackfillService);
    expect(providers).toContain(EligibilityService);
  });

  it('registers the relay actuators unconditionally (were worker-only)', () => {
    // Previously `processRunsWorker`-gated (loaded only in worker/combined). They now
    // always construct in the single process and self-gate on `isRelayConfigured` at
    // runtime — no longer absent in a relay-less process.
    expect(providers).toContain(RoomAdminsService);
    expect(providers).toContain(RelayAdminHealthService);
    expect(providers).toContain(RoomBackfillService);
    expect(providers).toContain(RoomBackfillProcessor);
    expect(providers).toContain(MembershipSyncService);
    expect(providers).toContain(ReconciliationService);
    expect(providers).toContain(ReorgEvictionService);
    expect(providers).toContain(ReconcileProcessor);
  });

  it('imports the feature config + the three sub-modules + the publish queue path', () => {
    // All imported unconditionally now (no per-mode dedupe). The sub-modules are
    // plain `@Module` classes (their own `forRoot({mode})` was removed too), so they
    // appear in the metadata as the class reference itself.
    expect(imports).toContain(PublishNip29Module);
    expect(imports).toContain(RoomNotificationsModule);
    expect(imports).toContain(ClientRoomApiModule);
    expect(imports).toContain(TgrObservabilityModule);
    // ConfigModule.forFeature(tgrConfig) + TypeOrmModule.forFeature(...) + the Bull
    // queues are DYNAMIC modules — stored as `{ module, providers, exports }` objects,
    // not the class — so match on the host `module` reference.
    const hostModules = imports.map((entry) =>
      entry && typeof entry === 'object' && 'module' in entry
        ? (entry as { module: unknown }).module
        : entry,
    );
    expect(hostModules).toContain(ConfigModule);
    expect(hostModules).toContain(TypeOrmModule);
    expect(hostModules).toContain(BullModule);
  });

  it('exports the public providers (identity/eligibility/admins) and shared modules', () => {
    expect(exports).toContain(IdentityService);
    expect(exports).toContain(EligibilityService);
    expect(exports).toContain(RoomAdminsService);
    expect(exports).toContain(RoomNotificationsModule);
    expect(exports).toContain(TypeOrmModule);
  });

  it('shares ONE RoomNotificationsModule class across both parents (no double-registration)', () => {
    // Regression guard for the prior combined-mode "Cannot define the same handler
    // twice" bug: when RoomNotificationsModule was a `forRoot({mode})` DynamicModule,
    // TokenGatedRoomsModule and the nested ClientRoomApiModule each produced a fresh
    // dynamic module that re-registered the `worker:room-notify` queue + its
    // @Processor. As a PLAIN @Module class it is the SAME reference in both parents'
    // imports, so NestJS instantiates it once → the queue + processors register once.
    const clientImports: unknown[] =
      Reflect.getMetadata('imports', ClientRoomApiModule) ?? [];
    expect(imports).toContain(RoomNotificationsModule);
    expect(clientImports).toContain(RoomNotificationsModule);
    // It must be a plain class, NOT a `{ module, ... }` DynamicModule and NOT carry a
    // forRoot factory — those are what reintroduce duplicate registration.
    expect(typeof RoomNotificationsModule).toBe('function');
    expect(
      (RoomNotificationsModule as unknown as { forRoot?: unknown }).forRoot,
    ).toBeUndefined();
  });
});

/**
 * The relay-config predicate is the single runtime gate that replaced the process
 * mode (worker/combined → "relay configured"; pure-main / no worker → "relay NOT
 * configured" → dormant). The module wires every provider regardless; whether the
 * relay actuators DO anything is decided by this predicate at runtime, so it is
 * asserted here directly. It accepts either the injected typed config
 * (`{ nostrRelayUrl, nostrBotNsec }`) or a raw env map (`{ TG_RELAY_URL, TG_BOT_NSEC }`).
 */
describe('isRelayConfigured (replaces the worker/main mode gate)', () => {
  // A valid (throwaway, test-only) bech32 nsec, mirroring the live relay env.
  const NSEC =
    'nsec16uz59vnceujqavzclzakpavkmwhxe0rc4krhzl6ewmv7lg0wrktqaagg40';

  it('relay configured (was "worker"/"combined") → enabled, via typed config', () => {
    expect(
      isRelayConfigured({
        nostrRelayUrl: 'ws://localhost:1',
        nostrBotNsec: NSEC,
      }),
    ).toBe(true);
  });

  it('relay configured → enabled, via raw env map', () => {
    expect(
      isRelayConfigured({
        TG_RELAY_URL: 'ws://localhost:1',
        TG_BOT_NSEC: NSEC,
      }),
    ).toBe(true);
  });

  it('relay NOT configured (was "main"/no worker) → dormant', () => {
    // Both missing.
    expect(isRelayConfigured({})).toBe(false);
    // URL only.
    expect(isRelayConfigured({ nostrRelayUrl: 'ws://localhost:1' })).toBe(
      false,
    );
    // nsec only.
    expect(isRelayConfigured({ nostrBotNsec: NSEC })).toBe(false);
    // Blank strings count as unset (no longer a fail-fast — just dormant).
    expect(isRelayConfigured({ nostrRelayUrl: '', nostrBotNsec: '   ' })).toBe(
      false,
    );
  });
});
