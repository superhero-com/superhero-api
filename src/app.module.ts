import { ScheduleModule } from '@nestjs/schedule';
import { BullBoardModule } from './bull-board/bull-board.module';

import { BullModule } from '@nestjs/bull';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AePricingModule } from './ae-pricing/ae-pricing.module';
import { AeModule } from './ae/ae.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BclModule } from './bcl/bcl.module';
import { DATABASE_CONFIG, REDIS_CONFIG } from './configs';
import {
  DELETE_OLD_TOKENS_QUEUE,
  PULL_TOKEN_INFO_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
} from './tokens/queues/constants';
import { TokensModule } from './tokens/tokens.module';
import { TransactionsModule } from './transactions/transactions.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AffiliationModule } from './affiliation/affiliation.module';
import { AccountModule } from './account/account.module';
import { TrendingTagsModule } from './trending-tags/trending-tags.module';
import { PostModule } from './social/post.module';
import { DexModule } from './dex/dex.module';
import { TipModule } from './tipping/tip.module';
import { MdwModule } from './mdw-sync/mdw.module';
import { SyncState } from './mdw-sync/entities/sync-state.entity';
import { DeprecatedApisModule } from './@deprecated-apis/deprecated-apis.module';

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
    TypeOrmModule.forFeature([SyncState]),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
      playground: false,
      graphiql: true, // enables GraphiQL instead
      introspection: true,
      hideSchemaDetailsFromClientErrors: true,
    }),
    MdwModule,
    AeModule,
    TokensModule,
    TransactionsModule,
    AePricingModule,
    BclModule,
    AnalyticsModule,
    BullBoardModule,
    AffiliationModule,
    AccountModule,
    TrendingTagsModule,
    PostModule,
    DexModule,
    TipModule,
    DeprecatedApisModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
