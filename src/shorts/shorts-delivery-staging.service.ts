import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import {
  IngestionInput,
  ShortsMetadataService,
  ShortsScope,
} from './shorts-metadata.service';
import {
  shortsDeliverySource,
  assertDeliverySourcePreparation,
} from './shorts-delivery-source';
import { officialContentPolicy } from './shorts-eligibility';
import type { ShortRecord } from './shorts.types';

export interface DeliveryStagingClaim {
  jobId: string;
  shortId: string;
  creator: string;
  input: IngestionInput;
  manifest: string;
  state: 'staging' | 'ready' | 'failed';
  fence: string;
  token?: string;
}

/** Internal coordinator metadata. No media bytes, public route or worker grants. */
@Injectable()
export class ShortsDeliveryStagingService {
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    private readonly metadata: ShortsMetadataService,
  ) {}
  private args(scope: ShortsScope, id: string) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(id)
    )
      throw new Error('Invalid original staging identity');
    return [scope.network, scope.contract, id];
  }
  private claim(row: any): DeliveryStagingClaim {
    return {
      jobId: row.job_id,
      shortId: row.delivery_short_id,
      creator: row.creator,
      input: row.input,
      manifest: row.manifest,
      state: row.state,
      fence: String(row.fence),
      token: row.lease_token ?? undefined,
    };
  }
  async get(
    scope: ShortsScope,
    jobId: string,
  ): Promise<DeliveryStagingClaim | undefined> {
    const [row] = await this.db.query(
      `SELECT s.*,j.delivery_short_id,j.creator,j.input FROM shorts_delivery_staging s
      JOIN shorts_ingestion j ON j.network=s.network AND j.contract=s.contract AND j.id=s.job_id
      WHERE s.network=$1 AND s.contract=$2 AND s.job_id=$3`,
      this.args(scope, jobId),
    );
    return row ? this.claim(row) : undefined;
  }
  private async eligible(
    db: EntityManager,
    scope: ShortsScope,
    shortId: string,
  ) {
    const [row] = await db.query(
      'SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3 FOR SHARE',
      this.args(scope, shortId),
    );
    const short: ShortRecord = row?.body;
    if (
      !short ||
      short.publication !== 'published' ||
      !officialContentPolicy(short).serve
    )
      throw new ConflictException(
        'Original Short is not eligible for restaging',
      );
    shortsDeliverySource(short);
    return short;
  }
  async reserve(
    scope: ShortsScope,
    jobId: string,
    shortId: string,
    input: IngestionInput,
    manifest: string,
  ) {
    const args = this.args(scope, jobId);
    const result = await this.db.transaction(async (db) => {
      // Match ordinary admission lock order before checking or creating a job.
      await db.query(
        'SELECT contract FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
        args.slice(0, 2),
      );
      const short = await this.eligible(db, scope, shortId);
      const source = shortsDeliverySource(short);
      assertDeliverySourcePreparation(source);
      if (
        input.processingProfile !== 'original-h264-v1' ||
        input.bytes !== source.bytes ||
        input.sha256 !== source.sha256
      )
        throw new ConflictException(
          'Restaging must preserve the canonical original',
        );
      const job = await this.metadata.enqueue(
        scope,
        jobId,
        short.creator,
        input,
        db,
        shortId,
        manifest,
      );
      const [old] = await db.query(
        'SELECT * FROM shorts_delivery_staging WHERE network=$1 AND contract=$2 AND job_id=$3 FOR UPDATE',
        args,
      );
      if (old && old.manifest !== manifest)
        throw new ConflictException('Original staging manifest changed');
      if (old?.state === 'ready')
        return this.claim({
          ...old,
          delivery_short_id: shortId,
          creator: job.creator,
          input: job.input,
        });
      if (old?.attempts >= 3) {
        if (old.state === 'staging') {
          const expired = await db.query(
            `WITH changed AS (UPDATE shorts_delivery_staging SET state='failed',lease_token=NULL,lease_until=NULL
            WHERE network=$1 AND contract=$2 AND job_id=$3 AND lease_until<=clock_timestamp() RETURNING job_id) SELECT * FROM changed`,
            args,
          );
          if (!expired.length)
            throw new ConflictException('Original staging lease is active');
          await db.query(
            `UPDATE shorts_ingestion SET status='failed',error_code='source_staging_failed',updated_at=clock_timestamp()
            WHERE network=$1 AND contract=$2 AND id=$3`,
            args,
          );
        }
        return undefined;
      }
      if (
        job.status === 'failed' &&
        old &&
        job.attempts === 0 &&
        job.fence === '0'
      ) {
        await this.metadata.admission(db, scope, job.creator);
        await db.query(
          "UPDATE shorts_ingestion SET status='queued',error_code=NULL,updated_at=clock_timestamp() WHERE network=$1 AND contract=$2 AND id=$3",
          args,
        );
      } else if (
        job.status !== 'queued' ||
        job.attempts !== 0 ||
        job.fence !== '0'
      )
        throw new ConflictException('Replacement job is already claimed');
      const token = randomUUID();
      const [row] = old
        ? await db.query(
            `WITH changed AS (UPDATE shorts_delivery_staging SET state='staging',fence=fence+1,attempts=attempts+1,
          lease_token=$4,lease_until=clock_timestamp()+interval '180 seconds' WHERE network=$1 AND contract=$2 AND job_id=$3 RETURNING *) SELECT * FROM changed`,
            [...args, token],
          )
        : await db.query(
            `INSERT INTO shorts_delivery_staging(network,contract,job_id,manifest,state,fence,attempts,lease_token,lease_until)
          VALUES($1,$2,$3,$4,'staging',1,1,$5,clock_timestamp()+interval '180 seconds') RETURNING *`,
            [...args, manifest, token],
          );
      return this.claim({
        ...row,
        delivery_short_id: shortId,
        creator: job.creator,
        input: job.input,
      });
    });
    if (!result)
      throw new ConflictException('Original staging retry limit reached');
    return result;
  }
  async finish(scope: ShortsScope, claim: DeliveryStagingClaim) {
    return this.db.transaction(async (db) => {
      await this.eligible(db, scope, claim.shortId);
      const changed = await db.query(
        `WITH changed AS (UPDATE shorts_delivery_staging SET state='ready',lease_token=NULL,lease_until=NULL
        WHERE network=$1 AND contract=$2 AND job_id=$3 AND state='staging' AND fence=$4 AND lease_token=$5
        AND lease_until>clock_timestamp() AND EXISTS(SELECT FROM shorts_ingestion j WHERE j.network=$1 AND j.contract=$2 AND j.id=$3 AND j.delivery_short_id=$6) RETURNING job_id) SELECT * FROM changed`,
        [
          ...this.args(scope, claim.jobId),
          claim.fence,
          claim.token,
          claim.shortId,
        ],
      );
      if (!changed.length)
        throw new ConflictException('Original staging claim changed');
    });
  }
  async fail(scope: ShortsScope, claim: DeliveryStagingClaim) {
    await this.db.transaction(async (db) => {
      const changed = await db.query(
        `WITH changed AS (UPDATE shorts_delivery_staging SET state='failed',lease_token=NULL,lease_until=NULL
        WHERE network=$1 AND contract=$2 AND job_id=$3 AND state='staging' AND fence=$4 AND lease_token=$5 RETURNING job_id) SELECT * FROM changed`,
        [...this.args(scope, claim.jobId), claim.fence, claim.token],
      );
      if (changed.length)
        await db.query(
          `UPDATE shorts_ingestion SET status='failed',error_code='source_staging_failed',updated_at=clock_timestamp()
        WHERE network=$1 AND contract=$2 AND id=$3 AND status='queued' AND attempts=0 AND fence=0`,
          this.args(scope, claim.jobId),
        );
    });
  }
}
