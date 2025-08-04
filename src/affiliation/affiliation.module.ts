import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AffiliationCode } from './entities/affiliation-code.entity';
import { Affiliation } from './entities/affiliation.entity';
import { AffiliationController } from './controllers/affiliation.controller';
import { OAuthService } from './services/oauth.service';
import { InvitationService } from './services/invitation.service';
import { AeModule } from '@/ae/ae.module';
import { Invitation } from './entities/invitation.entity';
import { InvitationsController } from './controllers/invitations.controller';

@Module({
  imports: [
    AeModule,
    TypeOrmModule.forFeature([Affiliation, AffiliationCode, Invitation]),
  ],
  providers: [OAuthService, InvitationService],
  exports: [],
  controllers: [AffiliationController, InvitationsController],
})
export class AffiliationModule {
  //
}
