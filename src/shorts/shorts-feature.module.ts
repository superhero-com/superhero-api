import 'dotenv/config';
import { DynamicModule, Module } from '@nestjs/common';

// Keep imports lazy: disabled API instances must not load SQLite, signing keys,
// upload storage, chain clients, or Shorts reconciliation timers.
@Module({})
export class ShortsFeatureModule {
  static register(): DynamicModule {
    return {
      module: ShortsFeatureModule,
      imports:
        process.env.ENABLE_SHORTS === 'true'
          ? [
              import('./shorts.module').then((m) => ({
                module: m.ShortsTestnetModule,
              })),
            ]
          : [],
    };
  }
}
