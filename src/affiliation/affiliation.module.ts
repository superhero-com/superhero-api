import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AffiliationCode } from './entities/affiliation-code.entity';
import { Affiliation } from './entities/affiliation.entity';
import { AffiliationController } from './controllers/affiliation.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Affiliation, AffiliationCode])],
  providers: [],
  exports: [],
  controllers: [AffiliationController],
})
export class AffiliationModule {
  //
}
