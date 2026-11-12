import { ShortsDatabaseService } from './shorts-database.service';
import {
  Inject,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ShortsScope } from './shorts-metadata.service';

export interface StreamClaim {
  id: string;
  cid: string;
  generation: string;
  token: string;
}

/** Shared at-least-once dispatch. Preparing the same video must be idempotent. */
@Injectable()
export class ShortsStreamJobsService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}

  private scope(scope: ShortsScope) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract)
    )
      throw new BadRequestException('Invalid Shorts deployment scope');
    return [scope.network, scope.contract];
  }
  private id(id: string) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))
      throw new BadRequestException('Invalid Short ID');
    return id;
  }
  async verify(scope: ShortsScope, sourceHash: string) {
    const [runtime] = await this.db.query(
      'SELECT source_hash FROM shorts_runtime WHERE network=$1 AND contract=$2',
      this.scope(scope),
    );
    if (!runtime || runtime.source_hash !== sourceHash)
      throw new ServiceUnavailableException(
        'Shared playback deployment does not match',
      );
    // Fail startup when the migration is missing, even before any video is published.
    await this.db.query(
      'SELECT id FROM shorts_stream_jobs WHERE network=$1 AND contract=$2 LIMIT 1',
      this.scope(scope),
    );
  }
  async enqueue(scope: ShortsScope, id: string) {
    const args = [...this.scope(scope), this.id(id)];
    return this.db.transaction(async (db) => {
      // Content -> outbox is also the trigger's lock order. Never resurrect a withdrawn job.
      const [short] = await db.query(
        'SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3 FOR SHARE',
        args,
      );
      if (!short || short.body.publication !== 'published') return;
      await db.query(
        `INSERT INTO shorts_stream_jobs(network,contract,id,cid) VALUES($1,$2,$3,$4)
        ON CONFLICT DO NOTHING`,
        [...args, short.body.cid],
      );
    });
  }
  async claim(
    scope: ShortsScope,
    leaseMs = 30000,
  ): Promise<StreamClaim | undefined> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60000)
      throw new BadRequestException('Invalid playback lease');
    const token = randomUUID();
    const [rows] = await this.db.query(
      `WITH candidate AS (
        SELECT network,contract,id FROM shorts_stream_jobs
        WHERE network=$1 AND contract=$2 AND NOT ready AND next_at<=clock_timestamp()
          AND (lease_until IS NULL OR lease_until<=clock_timestamp())
        ORDER BY next_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE shorts_stream_jobs j SET lease_token=$3,
        lease_until=clock_timestamp()+($4::integer*interval '1 millisecond')
      FROM candidate c WHERE j.network=c.network AND j.contract=c.contract AND j.id=c.id
      RETURNING j.id,j.cid,j.generation`,
      [...this.scope(scope), token, leaseMs],
    );
    const row = rows[0];
    return row
      ? { id: row.id, cid: row.cid, generation: String(row.generation), token }
      : undefined;
  }
  async settle(
    scope: ShortsScope,
    claim: StreamClaim,
    outcome: 'ready' | 'pending' | 'failed' | 'denied',
  ) {
    this.id(claim.id);
    if (
      !/^[1-9][0-9]{0,18}$/.test(claim.generation) ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(claim.token) ||
      !['ready', 'pending', 'failed', 'denied'].includes(outcome)
    )
      throw new BadRequestException('Invalid playback completion');
    const args = [
      ...this.scope(scope),
      claim.id,
      claim.generation,
      claim.token,
    ];
    return this.db.transaction(async (db) => {
      const [row] = await db.query(
        `SELECT attempts FROM shorts_stream_jobs
        WHERE network=$1 AND contract=$2 AND id=$3 AND generation=$4 AND lease_token=$5 FOR UPDATE`,
        args,
      );
      if (!row) return false;
      // Read the database clock after acquiring the lock: a blocked acknowledgement may expire.
      if (outcome === 'denied') {
        const [rows] = await db.query(
          `DELETE FROM shorts_stream_jobs
          WHERE network=$1 AND contract=$2 AND id=$3 AND generation=$4 AND lease_token=$5
            AND lease_until>clock_timestamp() RETURNING id`,
          args,
        );
        return rows.length === 1;
      }
      const attempts =
        outcome === 'failed' ? Math.min(16, row.attempts + 1) : 0;
      const delay =
        outcome === 'failed' ? Math.min(300000, 1000 * 2 ** attempts) : 15000;
      const [rows] = await db.query(
        `UPDATE shorts_stream_jobs SET ready=$6,attempts=$7,
        next_at=clock_timestamp()+($8::integer*interval '1 millisecond'),lease_token=NULL,lease_until=NULL
        WHERE network=$1 AND contract=$2 AND id=$3 AND generation=$4 AND lease_token=$5
          AND lease_until>clock_timestamp() RETURNING id`,
        [...args, outcome === 'ready', attempts, delay],
      );
      return rows.length === 1;
    });
  }
}
