import { ShortsDatabaseService } from './shorts-database.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  SHORTS_WORKER_CONFIG,
  ShortsWorkerConfig,
} from './shorts-worker.config';
import {
  IngestionClaim,
  IngestionJob,
  ShortsScope,
  StoredShort,
} from './shorts-metadata.service';
import { ShortRecord } from './shorts.types';

/** This login has no table access. PostgreSQL owns scope, leases and draft-only writes. */
@Injectable()
export class ShortsWorkerRepositoryService {
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    @Inject(SHORTS_WORKER_CONFIG) private readonly config: ShortsWorkerConfig,
  ) {}
  private async call(action: string, scope: ShortsScope, data: object = {}) {
    try {
      const [{ result }] = await this.db.query(
        'SELECT shorts_media_worker($1,$2::jsonb) AS result',
        [
          action,
          JSON.stringify({
            ...data,
            ...scope,
            sourceHash: this.config.sourceHash,
          }),
        ],
      );
      return result;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (code === 'SH401')
        throw new ForbiddenException(
          'Media worker database authority is not configured correctly',
        );
      if (code === 'SH409')
        throw new ConflictException(
          'Preparation claim expired or was replaced',
        );
      if (code === 'SH400')
        throw new BadRequestException('Invalid media worker request');
      throw error;
    }
  }
  async verifyRuntime(scope: ShortsScope, sourceHash: string) {
    if (sourceHash !== this.config.sourceHash)
      throw new ConflictException('Worker source does not match');
    const capabilities = await this.call('verify', scope);
    if (capabilities?.capacityDeferVersion !== 1)
      throw new ServiceUnavailableException(
        'Apply the Shorts worker capacity-backpressure migration before starting workers',
      );
    // Catalog reads need no application-table grants. Resolve the table through
    // the enrolled RPC's schema, so a temporary relation cannot shadow it.
    const [{ ready }] = await this.db.query(`SELECT EXISTS(
      SELECT FROM pg_catalog.pg_proc boundary
      JOIN pg_catalog.pg_class jobs ON jobs.relnamespace=boundary.pronamespace AND jobs.relname='shorts_ingestion'
      JOIN pg_catalog.pg_trigger guard ON guard.tgrelid=jobs.oid
      JOIN pg_catalog.pg_proc enforcement ON enforcement.oid=guard.tgfoid
      WHERE boundary.oid=pg_catalog.to_regprocedure('shorts_media_worker(text,jsonb)')
        AND guard.tgname='shorts_processing_capacity' AND guard.tgenabled IN ('O','A') AND guard.tgtype=23
        AND enforcement.pronamespace=boundary.pronamespace AND enforcement.proname='shorts_processing_capacity'
    ) AS ready`);
    if (!ready)
      throw new ServiceUnavailableException(
        'Apply and enable the Shorts processing-capacity migration before starting workers',
      );
  }
  async workerPulse(scope: ShortsScope, workerId: string) {
    await this.call('pulse', scope, { workerId });
  }
  async workerStop(scope: ShortsScope, workerId: string) {
    await this.call('stop', scope, { workerId });
  }
  async claim(
    scope: ShortsScope,
    leaseMs = 120000,
  ): Promise<IngestionJob | undefined> {
    const row = await this.call('claim', scope, { leaseMs });
    return row
      ? {
          id: row.id,
          creator: row.creator,
          input: row.input,
          status: row.status,
          attempts: row.attempts,
          fence: String(row.fence),
          leaseToken: row.lease_token,
          leaseUntil: new Date(row.lease_until),
        }
      : undefined;
  }
  async heartbeat(
    scope: ShortsScope,
    claim: IngestionClaim,
    leaseMs = 120000,
  ): Promise<boolean> {
    return this.call('heartbeat', scope, { ...claim, leaseMs });
  }
  async fail(scope: ShortsScope, claim: IngestionClaim): Promise<boolean> {
    return this.call('fail', scope, claim);
  }
  async defer(scope: ShortsScope, claim: IngestionClaim): Promise<boolean> {
    return this.call('defer', scope, {
      id: claim.id,
      fence: claim.fence,
      leaseToken: claim.leaseToken,
    });
  }
  async complete(
    scope: ShortsScope,
    claim: IngestionClaim,
    record: ShortRecord,
  ): Promise<StoredShort> {
    return this.call('complete', scope, { ...claim, record });
  }
}
