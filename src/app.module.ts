import { ScheduleModule } from '@nestjs/schedule';

import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from './ae/ae.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DATABASE_CONFIG, REDIS_CONFIG } from './configs';
import {
  DELETE_OLD_TOKENS_QUEUE,
  PULL_TOKEN_INFO_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
} from './tokens/queues/constants';
import { TokensModule } from './tokens/tokens.module';
import {
  SAVE_TRANSACTION_QUEUE,
  SYNC_TRANSACTIONS_QUEUE,
  VALIDATE_TRANSACTIONS_QUEUE,
} from './transactions/queues/constants';
import { TransactionsModule } from './transactions/transactions.module';
import { AePricingModule } from './ae-pricing/ae-pricing.module';
import { CacheModule } from '@nestjs/cache-manager';

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
        name: SAVE_TRANSACTION_QUEUE,
      },
      {
        name: SYNC_TRANSACTIONS_QUEUE,
      },
      {
        name: DELETE_OLD_TOKENS_QUEUE,
      },
      {
        name: VALIDATE_TRANSACTIONS_QUEUE,
      },
    ),
    TypeOrmModule.forRoot({
      ...DATABASE_CONFIG,
      entities: [__dirname + '/**/entities/*.entity{.ts,.js}'],
    }),
    AeModule,
    TokensModule,
    TransactionsModule,
    AePricingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
