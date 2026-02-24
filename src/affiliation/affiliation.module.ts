import { AccountModule } from '@/account/account.module';
import { AeModule } from '@/ae/ae.module';
import { Module } from '@nestjs/common';
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

@Module({
  imports: [
    AeModule,
    AccountModule,
    TypeOrmModule.forFeature([Affiliation, AffiliationCode, Invitation]),
  ],
  providers: [OAuthService, BclAffiliationAnalyticsService, BclAffiliationTreeService],
  exports: [],
  controllers: [AffiliationController, InvitationsController, BclAffiliationAnalyticsController, BclAffiliationTreeController],
})
export class AffiliationModule {
  //
}
