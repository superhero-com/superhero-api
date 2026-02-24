import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from '@/ae/ae.module';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import governanceConfig from './config/governance.config';
import { GovernancePlugin } from './governance.plugin';
import { GovernancePluginSyncService } from './governance-plugin-sync.service';
import { GovernanceVoteService } from './services/governance-vote.service';
import { GovernanceVotesController } from './controllers/governance-votes.controller';
import { GovernancePoll } from './entities/governance-poll.view';
import { GovernancePollVote } from './entities/governance-poll-vote.view';
import { GovernanceDelegation } from './entities/governance-delegation.view';
import { GovernanceRevokedDelegation } from './entities/governance-revoked-delegation.view';
import { GovernanceDelegationService } from './services/governance-delegation.service';
import { GovernanceDelegationsController } from './controllers/governance-delegations.controller';
import { GovernancePopularRankingService } from './services/governance-popular-ranking.service';

@Module({
  imports: [
    AeModule,
    ConfigModule.forFeature(governanceConfig),
    TypeOrmModule.forFeature([
      Tx,
      PluginSyncState,
      GovernancePoll,
      GovernancePollVote,
      GovernanceDelegation,
      GovernanceRevokedDelegation,
    ]),
  ],
  providers: [
    GovernancePluginSyncService,
    GovernancePlugin,
    GovernanceVoteService,
    GovernanceDelegationService,
    GovernancePopularRankingService,
  ],
  controllers: [GovernanceVotesController, GovernanceDelegationsController],
  exports: [GovernancePlugin, GovernancePopularRankingService],
})
export class GovernancePluginModule {}
