import { AeModule } from '@/ae/ae.module';
import { AffiliationModule } from '@/affiliation/affiliation.module';
import { Account } from '@/account/entities/account.entity';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProfileController } from './controllers/profile.controller';
import { ProfileCache } from './entities/profile-cache.entity';
import { ProfileSyncState } from './entities/profile-sync-state.entity';
import { ProfileXInviteChallenge } from './entities/profile-x-invite-challenge.entity';
import { ProfileXInvite } from './entities/profile-x-invite.entity';
import { ProfileXInviteCredit } from './entities/profile-x-invite-credit.entity';
import { ProfileXInviteMilestoneReward } from './entities/profile-x-invite-milestone-reward.entity';
import { ProfileXVerificationReward } from './entities/profile-x-verification-reward.entity';
import { ProfileAttestationService } from './services/profile-attestation.service';
import { ProfileContractService } from './services/profile-contract.service';
import { ProfileIndexerService } from './services/profile-indexer.service';
import { ProfileLiveSyncService } from './services/profile-live-sync.service';
import { ProfileReadService } from './services/profile-read.service';
import { ProfileSpendQueueService } from './services/profile-spend-queue.service';
import { ProfileXInviteService } from './services/profile-x-invite.service';
import { ProfileXVerificationRewardService } from './services/profile-x-verification-reward.service';

@Module({
  imports: [
    AeModule,
    forwardRef(() => AffiliationModule),
    TypeOrmModule.forFeature([
      ProfileCache,
      ProfileSyncState,
      ProfileXVerificationReward,
      ProfileXInviteChallenge,
      ProfileXInvite,
      ProfileXInviteCredit,
      ProfileXInviteMilestoneReward,
      Account,
    ]),
  ],
  providers: [
    ProfileAttestationService,
    ProfileContractService,
    ProfileIndexerService,
    ProfileLiveSyncService,
    ProfileReadService,
    ProfileSpendQueueService,
    ProfileXInviteService,
    ProfileXVerificationRewardService,
  ],
  controllers: [ProfileController],
  exports: [TypeOrmModule, ProfileReadService, ProfileContractService],
})
export class ProfileModule {}
