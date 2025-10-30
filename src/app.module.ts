import { ScheduleModule } from '@nestjs/schedule';
import { BullBoardModule } from './bull-board/bull-board.module';

import { BullModule } from '@nestjs/bull';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AePricingModule } from './ae-pricing/ae-pricing.module';
import { AeModule } from './ae/ae.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DATABASE_CONFIG, REDIS_CONFIG } from './configs';
import { MdwModule } from './mdw-sync/mdw.module';
import { AccountModule } from './plugins/account/account.module';
import { AffiliationModule } from './plugins/affiliation/affiliation.module';
import { BclModule } from './plugins/bcl/bcl.module';
import { TokensModule } from './plugins/bcl/tokens.module';
import { TransactionsModule } from './plugins/bcl/transactions.module';
import { DexPluginModule } from './plugins/dex/dex-plugin.module';
import { SocialPluginModule } from './plugins/social/social-plugin.module';
import { TippingPluginModule } from './plugins/tipping/tipping-plugin.module';
import { TrendingTagsModule } from './trending-tags/trending-tags.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot(),
    CacheModule.register({
      isGlobal: true,
    }),
    BullModule.forRoot({
      redis: REDIS_CONFIG,
    }),
    TypeOrmModule.forRoot({
      ...DATABASE_CONFIG,
      entities: [__dirname + '/**/entities/*.entity{.ts,.js}'],
    }),
    AeModule,
    MdwModule,
    DexPluginModule,
    SocialPluginModule,
    TippingPluginModule,
    TokensModule,
    TransactionsModule,
    AePricingModule,
    BclModule,
    AnalyticsModule,
    BullBoardModule,
    AffiliationModule,
    AccountModule,
    TrendingTagsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
