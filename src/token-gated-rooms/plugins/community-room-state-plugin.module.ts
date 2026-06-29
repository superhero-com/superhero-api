import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { SyncState } from '@/mdw-sync/entities/sync-state.entity';
import { Token } from '@/tokens/entities/token.entity';
import { AeModule } from '@/ae/ae.module';
import tgrConfig from '../config/tgr.config';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import { RoomStateService } from '../services/room-state.service';
import { CommunityRoomBackfillService } from '../services/community-room-backfill.service';
import { ReorgEvictionService } from '../services/reorg-eviction.service';
import { CommunityRoomStateSyncService } from './community-room-state-sync.service';
import { CommunityRoomStatePlugin } from './community-room-state.plugin';

/**
 * Community-room state indexer module (Task 04, MAIN process).
 *
 * Mirrors `BclPluginModule`: registers the plugin + its sync service + the
 * shared read/backfill services and the repos they need. The integrator wires
 * `CommunityRoomStatePlugin` into `src/plugins/index.ts`
 * (`PLUGIN_MODULES` + `getPluginProvider` → `MDW_PLUGIN`) so the reorg service
 * and live indexer reach it. EventEmitter2 is global (registered by mdw-sync),
 * so it is injectable without importing anything here.
 *
 * `RoomStateService` is exported so eligibility (06) / eager backfill (09) can
 * reuse the canonical read path; `CommunityRoomBackfillService` is exported so a
 * scheduler/CLI can drive the resumable sweep.
 */
@Module({
  imports: [
    ConfigModule.forFeature(tgrConfig),
    TypeOrmModule.forFeature([
      Tx,
      PluginSyncState,
      SyncState,
      Token,
      CommunityRoom,
      RoomMembership,
    ]),
    AeModule,
  ],
  providers: [
    RoomStateService,
    CommunityRoomBackfillService,
    CommunityRoomStateSyncService,
    CommunityRoomStatePlugin,
    // Task 11: the plugin's onReorg buffers at-risk evictions (main-side). The
    // worker-only collaborators (publish queue + RoomAdminsService) are @Optional
    // on ReorgEvictionService, so it constructs here with repos only.
    ReorgEvictionService,
  ],
  exports: [
    CommunityRoomStatePlugin,
    RoomStateService,
    CommunityRoomBackfillService,
  ],
})
export class CommunityRoomStatePluginModule {}
