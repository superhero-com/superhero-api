import { AeModule } from '@/ae/ae.module';
import { AffiliationModule } from '@/affiliation/affiliation.module';
import { Account } from '@/account/entities/account.entity';
import { Invitation } from '@/affiliation/entities/invitation.entity';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProfileCache } from './entities/profile-cache.entity';
import { ProfileXInviteChallenge } from './entities/profile-x-invite-challenge.entity';
import { ProfileXInvite } from './entities/profile-x-invite.entity';
import { ProfileXInviteCredit } from './entities/profile-x-invite-credit.entity';
import { ProfileXInviteMilestoneReward } from './entities/profile-x-invite-milestone-reward.entity';
import { ProfileXPostingReward } from './entities/profile-x-posting-reward.entity';
import { ProfileChainNameController } from './controllers/profile-chain-name.controller';
import { ProfileReadService } from './services/profile-read.service';
import { ProfileSpendQueueService } from './services/profile-spend-queue.service';
import { ProfileXApiClientService } from './services/profile-x-api-client.service';
import { ProfileXInviteService } from './services/profile-x-invite.service';
import { ProfileXPostingRewardService } from './services/profile-x-posting-reward.service';
import { ProfileChainNameChallenge } from './entities/profile-chain-name-challenge.entity';
import { ProfileChainNameClaim } from './entities/profile-chain-name-claim.entity';
import { ProfileChainNameService } from './services/profile-chain-name.service';

@Module({
  imports: [
    AeModule,
    forwardRef(() => AffiliationModule),
    TypeOrmModule.forFeature([
      ProfileCache,
      ProfileXPostingReward,
      ProfileXInviteChallenge,
      ProfileXInvite,
      ProfileXInviteCredit,
      ProfileXInviteMilestoneReward,
      ProfileChainNameChallenge,
      ProfileChainNameClaim,
      Account,
      Invitation,
    ]),
  ],
  providers: [
    ProfileReadService,
    ProfileSpendQueueService,
    ProfileXApiClientService,
    ProfileXInviteService,
    ProfileXPostingRewardService,
    ProfileChainNameService,
  ],
  controllers: [ProfileChainNameController],
  exports: [TypeOrmModule, ProfileReadService, ProfileXPostingRewardService],
})
export class ProfileModule {}
