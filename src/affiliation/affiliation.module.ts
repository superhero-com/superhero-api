import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AffiliationCode } from './entities/affiliation-code.entity';
import { Affiliation } from './entities/affiliation.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Affiliation, AffiliationCode])],
  providers: [],
  exports: [],
  controllers: [],
})
export class AffiliationModule {
  //
}
