import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { SocialGraphPlugin } from './social-graph.plugin';
import { SocialGraphGateway } from './social-graph.gateway';
import { SocialGraphTransactionProcessorService } from './services/transaction-processor.service';
import { AeModule } from '@/ae/ae.module';
import { SocialGraphReadModule } from './social-graph-read.module';
import { SocialGraphProjectionService } from './social-graph-projection.service';
import { SocialGraphSnapshotService } from './social-graph-snapshot.service';
import { SocialGraphCatchupService } from './social-graph-catchup.service';
import { SocialGraphReconcileService } from './social-graph-reconcile.service';
import { SocialGraphOutboxService } from './social-graph-outbox.service';
import { SocialGraphWorkerService } from './social-graph-worker.service';

@Module({
  imports: [
    AeModule,
    SocialGraphReadModule,
    TypeOrmModule.forFeature([Tx, PluginSyncState]),
  ],
  providers: [
    SocialGraphPlugin,
    SocialGraphGateway,
    SocialGraphTransactionProcessorService,
    SocialGraphProjectionService,
    SocialGraphSnapshotService,
    SocialGraphCatchupService,
    SocialGraphReconcileService,
    SocialGraphOutboxService,
    SocialGraphWorkerService,
  ],
  exports: [SocialGraphPlugin],
})
export class SocialGraphPluginModule {}
