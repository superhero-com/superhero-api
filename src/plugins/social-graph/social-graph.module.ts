import { SocialGraphV2OutboxService } from './v2/social-graph-v2-outbox.service';
import { SocialGraphV2WorkerService } from './v2/social-graph-v2-worker.service';
import { SocialGraphV2ReconcileService } from './v2/social-graph-v2-reconcile.service';
import { SocialGraphV2CatchupService } from './v2/social-graph-v2-catchup.service';
import { SocialGraphV2QueryService } from './v2/social-graph-v2-query.service';
import { SocialGraphV2SnapshotService } from './v2/social-graph-v2-snapshot.service';
import { SocialGraphV2ProjectionService } from './v2/social-graph-v2-projection.service';
import { SocialGraphV2Service } from './v2/social-graph-v2.service';
import { SocialGraphV2Controller } from './v2/social-graph-v2.controller';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from '@/ae/ae.module';
import { ProfileModule } from '@/profile/profile.module';
import { SocialGraphEdge } from './entities/social-graph-edge.entity';
import { SocialGraphCount } from './entities/social-graph-count.entity';
import { SocialGraphController } from './social-graph.controller';
import { SocialGraphConfiguredGuard } from './social-graph-configured.guard';
import { SocialGraphService } from './social-graph.service';
import { SocialGraphContractService } from './social-graph-contract.service';
import { SocialGraphReconcileService } from './services/social-graph-reconcile.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([SocialGraphEdge, SocialGraphCount]),
    AeModule,
    ProfileModule,
  ],
  controllers: [SocialGraphController, SocialGraphV2Controller],
  providers: [
    SocialGraphV2Service,
    SocialGraphV2ProjectionService,
    SocialGraphV2SnapshotService,
    SocialGraphV2CatchupService,
    SocialGraphV2ReconcileService,
    SocialGraphV2WorkerService,
    SocialGraphV2OutboxService,
    SocialGraphV2QueryService,
    SocialGraphService,
    SocialGraphContractService,
    SocialGraphReconcileService,
    SocialGraphConfiguredGuard,
  ],
  exports: [
    SocialGraphContractService,
    SocialGraphService,
    SocialGraphV2Service,
  ],
})
export class SocialGraphModule {}
