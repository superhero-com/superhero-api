import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Analytic } from './entities/analytic.entity';
import { AnalyticController } from './controllers/analytic.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Analytic])],
  providers: [
    //
  ],
  exports: [],
  controllers: [AnalyticController],
})
export class AnalyticsModule {
  //
}
