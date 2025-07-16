import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AffiliationCode } from './entities/affiliation-code.entity';
import { Affiliation } from './entities/affiliation.entity';
import { AffiliationController } from './controllers/affiliation.controller';
import { OAuthService } from './services/oauth.service';

@Module({
  imports: [TypeOrmModule.forFeature([Affiliation, AffiliationCode])],
  providers: [OAuthService],
  exports: [],
  controllers: [AffiliationController],
})
export class AffiliationModule {
  //
}
