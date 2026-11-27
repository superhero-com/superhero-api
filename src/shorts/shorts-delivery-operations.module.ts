import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG } from '../configs/database';
import { ShortsTestnetModule } from './shorts.module';

/** One explicit operation; no HTTP listener, indexer or hosted background jobs. */
@Module({})
export class ShortsDeliveryOperationsModule {
  static async register(): Promise<DynamicModule> {
    return {
      module: ShortsDeliveryOperationsModule,
      imports: [
        TypeOrmModule.forRoot({
          ...DATABASE_CONFIG,
          synchronize: false,
          autoLoadEntities: false,
          logging: false,
          retryAttempts: 0,
          extra: { max: 1, connectionTimeoutMillis: 1000 },
        }),
        await ShortsTestnetModule.register(true, { operationsOnly: true }),
      ],
    };
  }
}
