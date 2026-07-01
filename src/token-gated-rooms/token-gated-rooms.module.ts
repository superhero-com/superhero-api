import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { Account } from '@/account/entities/account.entity';
import { Token } from '@/tokens/entities/token.entity';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { SyncState } from '@/mdw-sync/entities/sync-state.entity';
import tgrConfig from './config/tgr.config';
import { prefixQueue, TGR_QUEUE_NAMES } from './config/queue-prefix';
import { CommunityRoom } from './entities/community-room.entity';
import { RoomMembership } from './entities/room-membership.entity';
import { RoomMembershipEvent } from './entities/room-membership-event.entity';
import { RoomNotificationPreference } from './entities/room-notification-preference.entity';
import { RoomMessageSeen } from './entities/room-message-seen.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { RoomBackfillState } from './entities/room-backfill-state.entity';
import { IdentityService } from './services/identity.service';
import { IdentityBackfillService } from './services/identity-backfill.service';
import { EligibilityService } from './services/eligibility.service';
import { MembershipAccessService } from './services/membership-access.service';
import { RoomAdminsService } from './services/room-admins.service';
import { RelayAdminHealthService } from './nostr/relay-admin-health';
import { PublishNip29Module } from './queues/publish-nip29.module';
import { RoomBackfillService } from './services/room-backfill.service';
import { RoomBackfillProcessor } from './queues/room-backfill.processor';
import { MembershipSyncService } from './services/membership-sync.service';
import { GroupMissingTracker } from './services/group-missing-tracker.service';
import { ReconciliationService } from './services/reconciliation.service';
import { ReorgEvictionService } from './services/reorg-eviction.service';
import { ReconcileProcessor } from './queues/reconcile.processor';
import { RoomRecheckService } from './services/room-recheck.service';
import { RoomRecheckController } from './controllers/room-recheck.controller';
import { RoomNotificationsModule } from './room-notifications.module';
import { ClientRoomApiModule } from './client-room-api.module';
import { TgrObservabilityModule } from './observability/tgr-observability.module';

/**
 * TGR entities registered for repository injection (Task 00). Registered in both
 * modes so services in either process can read/write the desired-state tables.
 *
 * `Account` (Task 05) is added so {@link IdentityService} /
 * {@link IdentityBackfillService} can `@InjectRepository(Account)` to read the
 * already-materialized `Account.links[<provider>]` value.
 *
 * `Token` (Task 09) is added so {@link RoomBackfillService} can
 * `@InjectRepository(Token)` to drive the whole-registry eager room backfill off
 * the per-token `has_nostr_room` / `nostr_room_state` source of truth.
 *
 * `SyncState` (Task 11) is added so {@link ReconciliationService} and
 * {@link ReorgEvictionService} can `@InjectRepository(SyncState)` to read the chain
 * tip height (`id='global'`) that gates reorg holds / flush.
 */
const TGR_ENTITIES = [
  CommunityRoom,
  RoomMembership,
  RoomMembershipEvent,
  RoomNotificationPreference,
  RoomMessageSeen,
  TokenBalance,
  RoomBackfillState,
  Account,
  Token,
  // `token_holder` is the canonical, already-populated holder ledger (BCL indexer
  // + MDW reconcile). EligibilityService reads it directly — see its balance read.
  TokenHolder,
  SyncState,
];

/**
 * Token-gated rooms (NIP-29 / groups_relay).
 *
 * ONE always-on process (worker mode removed — see `deworker-plan.md`). Every
 * provider loads here: the chain-driven indexing listeners (eligibility, identity
 * backfill), the HTTP read API, AND the relay actuators (writer/subscriber + their
 * Bull consumers + the backfill/reconcile/membership-sync crons). The actuators
 * self-enable at runtime iff a relay is configured (`isRelayConfigured`) — when it
 * is not, they construct but stay dormant, so the public API + indexer still boot.
 *
 * The MDW indexer **plugins** (AEX9 transfer / community-room state) are NOT
 * registered here — they live in the global plugin registry (`src/plugins/index.ts`)
 * so the indexer + reorg service reach them.
 *
 * Bull queues are registered with their historical `main:`/`worker:` name prefixes
 * (now just a stable name component, DW5). The `worker:room-notify` queue is NOT
 * registered here — it lives entirely inside `RoomNotificationsModule` (its sole
 * producer + consumer), so registering it here would double-register the token.
 */
@Module({
  imports: [
    ConfigModule.forFeature(tgrConfig),
    TypeOrmModule.forFeature(TGR_ENTITIES),
    BullModule.registerQueue({
      name: prefixQueue('reconcile-balance', 'main'),
    }),
    BullModule.registerQueue({ name: prefixQueue('publish-nip29', 'worker') }),
    BullModule.registerQueue({
      name: prefixQueue(TGR_QUEUE_NAMES.ROOM_BACKFILL, 'worker'),
    }),
    BullModule.registerQueue({
      name: prefixQueue(TGR_QUEUE_NAMES.RECONCILE_MEMBERSHIP, 'worker'),
    }),
    // Relay write path: the publish queue (rate limiter + capped-backoff) + the
    // RelayWriter binding. Always imported now; the writer is dormant until a relay
    // is configured.
    PublishNip29Module,
    // Membership push notifications + per-room mute (its own `worker:room-notify`
    // queue + listener/processor + relay subscriber). Self-contained.
    RoomNotificationsModule,
    // HTTP read/query + signed per-room mute write.
    ClientRoomApiModule,
    // Metrics collector + `GET /api/tgr/metrics`. Imported AFTER the queues so its
    // @Optional() @InjectQueue tokens resolve.
    TgrObservabilityModule,
  ],
  providers: [
    // Shared: AE↔nostr resolution (eligibility + membership-sync inject it).
    IdentityService,
    // Indexer-driven desired-state (Postgres writes + enqueue only).
    IdentityBackfillService,
    EligibilityService,
    // Access-transition ledger (durable membership-push dedup + debounced revoke).
    // Injected by MembershipSyncService (grant/revoke folding) + ReconcileProcessor
    // (the finalize job).
    MembershipAccessService,
    // Relay actuators — construct always, self-gate on `isRelayConfigured`.
    RoomAdminsService,
    RelayAdminHealthService,
    RoomBackfillService,
    RoomBackfillProcessor,
    MembershipSyncService,
    // In-memory "group missing on relay" registry: debounces re-creates + lets
    // membership-sync stop adding members to a group being re-created.
    GroupMissingTracker,
    ReconciliationService,
    ReorgEvictionService,
    ReconcileProcessor,
    // On-demand per-caller access recheck (relay→DB heal + provision) backing the
    // `POST /rooms/:saleAddress/recheck` controller below.
    RoomRecheckService,
  ],
  controllers: [RoomRecheckController],
  exports: [
    IdentityService,
    EligibilityService,
    RoomAdminsService,
    RoomNotificationsModule,
    TypeOrmModule,
  ],
})
export class TokenGatedRoomsModule {}
