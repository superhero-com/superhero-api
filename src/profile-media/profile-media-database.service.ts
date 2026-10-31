import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  PROFILE_MEDIA_CONFIG,
  ProfileMediaConfig,
} from './profile-media.config';

/** Small independent pool: image processing never holds an application DB connection. */
@Injectable()
export class ProfileMediaDatabase
  extends DataSource
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    @Inject(DataSource) source: DataSource,
    @Inject(PROFILE_MEDIA_CONFIG) private readonly config: ProfileMediaConfig,
  ) {
    super({
      ...source.options,
      name: 'profile-media',
      entities: [],
      migrations: [],
      subscribers: [],
      synchronize: false,
      dropSchema: false,
      migrationsRun: false,
      logging: false,
      extra: {
        ...source.options.extra,
        max: 3,
        min: 0,
        connectionTimeoutMillis: 1500,
        statement_timeout: 8000,
        lock_timeout: 1500,
        idle_in_transaction_session_timeout: 10000,
        application_name: 'superhero-profile-media',
      },
    });
  }
  async onModuleInit() {
    if (this.config.enabled) await this.initialize();
  }
  async onModuleDestroy() {
    if (this.isInitialized) await this.destroy();
  }
}
