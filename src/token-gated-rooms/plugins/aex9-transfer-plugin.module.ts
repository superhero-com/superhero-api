import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ConfigModule } from '@nestjs/config';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { SyncState } from '@/mdw-sync/entities/sync-state.entity';
import { Token } from '@/tokens/entities/token.entity';
import { AeModule } from '@/ae/ae.module';
import { TokenBalance } from '../entities/token-balance.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import tgrConfig from '../config/tgr.config';
import { BalanceIndexerService } from '../services/balance-indexer.service';
import { BalanceReconciliationService } from '../services/balance-reconciliation.service';
import { RECONCILE_BALANCE_QUEUE } from '../services/balance-reconciliation.service';
import { ReorgEvictionService } from '../services/reorg-eviction.service';
import { Aex9TransferSyncService } from './aex9-transfer-sync.service';
import { Aex9TransferPlugin } from './aex9-transfer.plugin';

/**
 * AEX9 balance indexer plugin module (Task 03), mirroring `BclPluginModule`. This
 * is a **main-mode** indexer plugin: the integrator adds `Aex9TransferPluginModule`
 * to `PLUGIN_MODULES` and `Aex9TransferPlugin` to `getPluginProvider()` in
 * `src/plugins/index.ts`.
 *
 * It owns the `reconcile-balance` Bull queue (prefixed via `TGR_QUEUE_OWNER`,
 * which maps `reconcile-balance` to the **main** process → `main:reconcile-balance`;
 * the AEX9 sweep is driven by the indexer, not the relay worker), the
 * AEX9-transfer sync service, the community-token allowlist
 * (`BalanceIndexerService`), and the repeatable reconciliation sweep.
 *
 * `BalanceIndexerService` and `Aex9TransferPlugin` are exported so the global
 * plugin registry can inject the plugin (and tests/Task 06 can read the allowlist
 * helpers).
 */
@Module({
  imports: [
    ConfigModule.forFeature(tgrConfig),
    TypeOrmModule.forFeature([
      Tx,
      PluginSyncState,
      SyncState,
      Token,
      TokenBalance,
      RoomMembership,
    ]),
    AeModule,
    BullModule.registerQueue({ name: RECONCILE_BALANCE_QUEUE }),
  ],
  providers: [
    BalanceIndexerService,
    Aex9TransferSyncService,
    Aex9TransferPlugin,
    BalanceReconciliationService,
    // Task 11: the plugin's onReorg buffers at-risk evictions (main-side). The
    // worker-only collaborators (publish queue + RoomAdminsService) are @Optional
    // on ReorgEvictionService, so it constructs here with repos only.
    ReorgEvictionService,
  ],
  exports: [Aex9TransferPlugin, BalanceIndexerService],
})
export class Aex9TransferPluginModule {}
