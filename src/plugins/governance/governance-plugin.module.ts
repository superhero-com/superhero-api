import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import governanceConfig from './config/governance.config';
import { GovernancePlugin } from './governance.plugin';
import { GovernancePluginSyncService } from './governance-plugin-sync.service';
import { GovernancePoll } from './entities/governance-poll.entity';
import { GovernancePollVote } from './entities/governance-poll-vote.entity';
import { GovernanceDelegation } from './entities/governance-delegation.entity';

@Module({
  imports: [
    ConfigModule.forFeature(governanceConfig),
    TypeOrmModule.forFeature([
      Tx,
      PluginSyncState,
      GovernancePoll,
      GovernancePollVote,
      GovernanceDelegation,
    ]),
  ],
  providers: [
    GovernancePluginSyncService,
    GovernancePlugin,
  ],
  exports: [GovernancePlugin],
})
export class GovernancePluginModule {}

