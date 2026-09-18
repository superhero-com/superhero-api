import { AccountModule } from '@/account/account.module';
import { AeModule } from '@/ae/ae.module';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AffiliationController } from './controllers/affiliation.controller';
import { InvitationsController } from './controllers/invitations.controller';
import { AffiliationCode } from './entities/affiliation-code.entity';
import { Affiliation } from './entities/affiliation.entity';
import { Invitation } from './entities/invitation.entity';
import { OAuthService } from './services/oauth.service';
import { BclAffiliationAnalyticsService } from './services/bcl-affiliation-analytics.service';
import { BclAffiliationTreeService } from './services/bcl-affiliation-tree.service';
import { BclAffiliationAnalyticsController } from './controllers/bcl-affiliation-analytics.controller';
import { BclAffiliationTreeController } from './controllers/bcl-affiliation-tree.controller';
import { AffiliationDashboardAuthController } from './controllers/affiliation-dashboard-auth.controller';
import { AffiliationDashboardAuthService } from './services/affiliation-dashboard-auth.service';
import { AffiliationDashboardAdmin } from './entities/affiliation-dashboard-admin.entity';
import { AffiliationDashboardSession } from './entities/affiliation-dashboard-session.entity';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { ProfileXInvite } from '@/profile/entities/profile-x-invite.entity';
import { ProfileXInviteMilestoneReward } from '@/profile/entities/profile-x-invite-milestone-reward.entity';
import { ProfileXPostingReward } from '@/profile/entities/profile-x-posting-reward.entity';
import { ProfileXPostRewardLedger } from '@/profile/entities/profile-x-post-reward-ledger.entity';
import { ProfileXStreakBonusReward } from '@/profile/entities/profile-x-streak-bonus-reward.entity';

@Module({
  imports: [
    AeModule,
    forwardRef(() => AccountModule),
    TypeOrmModule.forFeature([
      Affiliation,
      AffiliationCode,
      Invitation,
      Tx,
      ProfileXInvite,
      ProfileXInviteMilestoneReward,
      ProfileXPostingReward,
      ProfileXPostRewardLedger,
      ProfileXStreakBonusReward,
      AffiliationDashboardAdmin,
      AffiliationDashboardSession,
    ]),
  ],
  providers: [
    OAuthService,
    BclAffiliationAnalyticsService,
    BclAffiliationTreeService,
    AffiliationDashboardAuthService,
  ],
  exports: [OAuthService],
  controllers: [
    AffiliationController,
    InvitationsController,
    BclAffiliationAnalyticsController,
    BclAffiliationTreeController,
    AffiliationDashboardAuthController,
  ],
})
export class AffiliationModule {
  //
}
