import { Module } from '@nestjs/common';
import { AeModule } from '@/ae/ae.module';
import { ProfileModule } from '@/profile/profile.module';
import { SocialGraphReadModule } from './social-graph-read.module';
import { SocialGraphController } from './social-graph.controller';
import { SocialGraphProjectionService } from './social-graph-projection.service';
import { SocialGraphSnapshotService } from './social-graph-snapshot.service';
import { SocialGraphCatchupService } from './social-graph-catchup.service';
import { SocialGraphReconcileService } from './social-graph-reconcile.service';
import { SocialGraphOutboxService } from './social-graph-outbox.service';
import { SocialGraphWorkerService } from './social-graph-worker.service';

@Module({
  imports: [AeModule, ProfileModule, SocialGraphReadModule],
  controllers: [SocialGraphController],
  providers: [
    SocialGraphProjectionService,
    SocialGraphSnapshotService,
    SocialGraphCatchupService,
    SocialGraphReconcileService,
    SocialGraphOutboxService,
    SocialGraphWorkerService,
  ],
  exports: [SocialGraphReadModule],
})
export class SocialGraphModule {}
