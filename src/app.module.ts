import { ScheduleModule } from '@nestjs/schedule';
import { BullBoardModule } from './bull-board/bull-board.module';

import { BullModule } from '@nestjs/bull';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountModule } from './account/account.module';
import { AePricingModule } from './ae-pricing/ae-pricing.module';
import { AeModule } from './ae/ae.module';
import { AffiliationModule } from './affiliation/affiliation.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BclModule } from './bcl/bcl.module';
import { DATABASE_CONFIG, REDIS_CONFIG } from './configs';
import { MdwModule } from './mdw/mdw.module';
import { DexPluginModule } from './plugins/dex/dex-plugin.module';
import { SocialPluginModule } from './plugins/social/social-plugin.module';
import { TippingPluginModule } from './plugins/tipping/tipping-plugin.module';
import {
  DELETE_OLD_TOKENS_QUEUE,
  PULL_TOKEN_INFO_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
} from './tokens/queues/constants';
import { TokensModule } from './tokens/tokens.module';
import { TransactionsModule } from './transactions/transactions.module';
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
    BullModule.registerQueue(
      {
        name: PULL_TOKEN_INFO_QUEUE,
      },
      {
        name: SYNC_TOKEN_HOLDERS_QUEUE,
      },
      {
        name: DELETE_OLD_TOKENS_QUEUE,
      },
    ),
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
