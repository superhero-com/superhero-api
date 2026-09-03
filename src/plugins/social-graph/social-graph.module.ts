import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from '@/ae/ae.module';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { SocialGraphEdge } from './entities/social-graph-edge.entity';
import { SocialGraphController } from './social-graph.controller';
import { SocialGraphConfiguredGuard } from './social-graph-configured.guard';
import { SocialGraphService } from './social-graph.service';
import { SocialGraphContractService } from './social-graph-contract.service';
import { SocialGraphReconcileService } from './services/social-graph-reconcile.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([SocialGraphEdge, PluginSyncState]),
    AeModule,
  ],
  controllers: [SocialGraphController],
  providers: [
    SocialGraphService,
    SocialGraphContractService,
    SocialGraphReconcileService,
    SocialGraphConfiguredGuard,
  ],
  exports: [SocialGraphContractService, SocialGraphService],
})
export class SocialGraphModule {}
