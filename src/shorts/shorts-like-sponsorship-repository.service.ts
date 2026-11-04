import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  LikeSponsorConfig,
  SHORTS_LIKE_SPONSOR_CONFIG,
} from './shorts-like-sponsorship.config';

/** One SQL-function boundary; API and signer have separate, explicitly enrolled logins. */
@Injectable()
export class ShortsLikeSponsorshipRepository
  implements OnModuleInit, OnModuleDestroy
{
  private db?: DataSource;
  constructor(
    @Inject(SHORTS_LIKE_SPONSOR_CONFIG) readonly config: LikeSponsorConfig,
  ) {}
  async onModuleInit() {
    if (!this.config.release) return;
    this.db = new DataSource({
      type: 'postgres',
      url: this.config.databaseUrl,
      entities: [],
      migrations: [],
      synchronize: false,
      logging: false,
      poolSize: 2,
      extra: {
        max: 2,
        connectionTimeoutMillis: 1000,
        statement_timeout: 10000,
        lock_timeout: 3000,
        idle_in_transaction_session_timeout: 15000,
      },
    });
    await this.db.initialize();
    const binding = await this.call('verify');
    if (binding.kind !== (this.config.keyFile ? 'signer' : 'api'))
      throw new Error('Wrong Like sponsorship queue role');
  }
  async onModuleDestroy() {
    if (this.db?.isInitialized) await this.db.destroy();
  }
  async call(action: string, data: object = {}) {
    const c = this.config;
    if (!c.release || !this.db?.isInitialized)
      throw new ServiceUnavailableException('Like sponsorship is unavailable');
    try {
      const [row] = await this.db.query(
        'SELECT shorts_like_sponsorship($1,$2::jsonb) AS result',
        [
          action,
          JSON.stringify({
            ...data,
            network: c.release.network,
            contract: c.release.contract,
            sourceHash: c.release.sourceHash,
            payer: c.payer,
            policy: c.policy,
            admissionEnabled: c.enabled,
            recovery: c.recovery === true,
          }),
        ],
      );
      return row.result;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (code === 'SH400')
        throw new BadRequestException('Invalid Like sponsorship request');
      if (code === 'SH401')
        throw new ForbiddenException('Like sponsorship authority unavailable');
      if (code === 'SH409')
        throw new ConflictException(
          'Like sponsorship identity or lease changed',
        );
      if (code === 'SH503')
        throw new ServiceUnavailableException(
          'Like sponsorship is paused or its budget is full',
        );
      throw error;
    }
  }
}
