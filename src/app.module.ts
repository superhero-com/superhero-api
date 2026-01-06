import { ScheduleModule } from '@nestjs/schedule';
import { BullBoardModule } from './bull-board/bull-board.module';

import { BullModule } from '@nestjs/bull';
import { CacheModule } from '@nestjs/cache-manager';
import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AePricingModule } from './ae-pricing/ae-pricing.module';
import { AeModule } from './ae/ae.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BclModule } from './bcl/bcl.module';
import { DATABASE_CONFIG, REDIS_CONFIG, synchronizeWithErrorHandling } from './configs';
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
export class AppModule implements OnModuleInit {
  constructor(private readonly dataSource: DataSource) { }

  async onModuleInit() {
    await this.fixCoinPricesPk();
    // Run synchronization with error handling for constraint conflicts
    await synchronizeWithErrorHandling(this.dataSource);
  }

  async fixCoinPricesPk(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // Only run if duplicates/nulls exist (optional but recommended)
      const [{ dup_ids }] = await manager.query(`
        SELECT COUNT(*)::int AS "dup_ids"
        FROM (
          SELECT id
          FROM coin_prices
          WHERE id IS NOT NULL
          GROUP BY id
          HAVING COUNT(*) > 1
        ) t
      `);

      const [{ null_ids }] = await manager.query(`
        SELECT COUNT(*)::int AS "null_ids"
        FROM coin_prices
        WHERE id IS NULL
      `);

      if (dup_ids === 0 && null_ids === 0) return;

      await manager.query(`
        WITH ordered AS (
          SELECT ctid, row_number() OVER (ORDER BY created_at, ctid) AS new_id
          FROM coin_prices
        )
        UPDATE coin_prices cp
        SET id = ordered.new_id
        FROM ordered
        WHERE cp.ctid = ordered.ctid
      `);

      await manager.query(`
        CREATE SEQUENCE IF NOT EXISTS coin_prices_id_seq OWNED BY coin_prices.id
      `);

      await manager.query(`
        SELECT setval(
          'coin_prices_id_seq',
          COALESCE((SELECT MAX(id) FROM coin_prices), 0)
        )
      `);

      await manager.query(`
        ALTER TABLE coin_prices
        ALTER COLUMN id SET DEFAULT nextval('coin_prices_id_seq')
      `);
    });
  }
}
