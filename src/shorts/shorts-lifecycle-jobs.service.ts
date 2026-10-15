import { ShortsDatabaseService } from './shorts-database.service';
import {
  Inject,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { ShortsScope } from './shorts-metadata.service';

export interface LifecycleClaim {
  id: string;
  generation: string;
  fence: string;
  token: string;
}
export type LifecycleResult =
  | 'checked'
  | 'publication_pending'
  | 'retention_pending'
  | 'reconciliation_required'
  | 'capacity_wait'
  | 'failed';

/** Bounded, renewable maintenance claims. A content-policy change invalidates old work. */
@Injectable()
export class ShortsLifecycleJobsService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}
  private scope(scope: ShortsScope) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract)
    )
      throw new BadRequestException('Invalid lifecycle scope');
    return [scope.network, scope.contract];
  }
  private claimArgs(scope: ShortsScope, claim: LifecycleClaim) {
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(claim.id) ||
      !/^[1-9][0-9]{0,18}$/.test(claim.generation) ||
      !/^[1-9][0-9]{0,18}$/.test(claim.fence) ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(claim.token)
    )
      throw new BadRequestException('Invalid lifecycle claim');
    return [
      ...this.scope(scope),
      claim.id,
      claim.generation,
      claim.fence,
      claim.token,
    ];
  }
  private lease(ms: number) {
    if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 120000)
      throw new BadRequestException('Invalid lifecycle lease');
    return ms;
  }
  async verify(scope: ShortsScope, sourceHash: string) {
    const [row] = await this.db.query(
      'SELECT source_hash FROM shorts_runtime WHERE network=$1 AND contract=$2',
      this.scope(scope),
    );
    if (!row || row.source_hash !== sourceHash)
      throw new ServiceUnavailableException('Lifecycle deployment mismatch');
    const [constraint] = await this.db
      .query(`SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema()
      AND t.relname='shorts_lifecycle_jobs' AND c.conname='shorts_lifecycle_jobs_result_check' AND c.convalidated`);
    if (!constraint?.definition.includes("'capacity_wait'"))
      throw new ServiceUnavailableException(
        'Apply the Shorts media-admission migration before starting lifecycle work',
      );
    await this.db.query(
      'SELECT id FROM shorts_lifecycle_jobs WHERE network=$1 AND contract=$2 LIMIT 1',
      this.scope(scope),
    );
  }
  async health(scope: ShortsScope) {
    const args = this.scope(scope);
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
      );
      const [row] = await db.query(
        `SELECT count(*) AS total,
        count(*) FILTER (WHERE lease_until>current_timestamp) AS active,
        count(*) FILTER (WHERE next_at<=current_timestamp AND
          (lease_until IS NULL OR lease_until<=current_timestamp)) AS due,
        count(*) FILTER (WHERE result='failed') AS failed,
        count(*) FILTER (WHERE result='capacity_wait') AS capacity_wait,
        count(*) FILTER (WHERE result='retention_pending') AS retention_pending,
        count(*) FILTER (WHERE result='reconciliation_required') AS reconciliation_required,
        coalesce(extract(epoch FROM current_timestamp-min(next_at) FILTER
          (WHERE next_at<=current_timestamp AND (lease_until IS NULL OR lease_until<=current_timestamp))),0)
          AS oldest_due_seconds,
        max(checked_at) AS last_checked_at
        FROM shorts_lifecycle_jobs WHERE network=$1 AND contract=$2`,
        args,
      );
      return {
        total: Number(row.total),
        active: Number(row.active),
        due: Number(row.due),
        failed: Number(row.failed),
        capacityWaiting: Number(row.capacity_wait),
        retentionPending: Number(row.retention_pending),
        reconciliationRequired: Number(row.reconciliation_required),
        oldestDueSeconds: Math.max(0, Number(row.oldest_due_seconds)),
        lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
      };
    });
  }
  async claim(
    scope: ShortsScope,
    leaseMs = 120000,
  ): Promise<LifecycleClaim | undefined> {
    const token = randomUUID();
    const [rows] = await this.db.query(
      `WITH candidate AS (
      SELECT network,contract,id FROM shorts_lifecycle_jobs WHERE network=$1 AND contract=$2
        AND next_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      ORDER BY next_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE shorts_lifecycle_jobs j SET fence=j.fence+1,lease_token=$3,
      lease_until=clock_timestamp()+$4::integer*interval '1 millisecond'
      FROM candidate c WHERE j.network=c.network AND j.contract=c.contract AND j.id=c.id
      RETURNING j.id,j.generation,j.fence`,
      [...this.scope(scope), token, this.lease(leaseMs)],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          generation: String(row.generation),
          fence: String(row.fence),
          token,
        }
      : undefined;
  }
  private async locked(
    scope: ShortsScope,
    claim: LifecycleClaim,
    change: (db: EntityManager, args: unknown[]) => Promise<boolean>,
  ) {
    const args = this.claimArgs(scope, claim);
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'",
      );
      const [row] = await db.query(
        `SELECT id FROM shorts_lifecycle_jobs
        WHERE network=$1 AND contract=$2 AND id=$3 AND generation=$4 AND fence=$5 AND lease_token=$6 FOR UPDATE`,
        args,
      );
      // Evaluate database time only after a potentially blocking row lock.
      return row ? change(db, args) : false;
    });
  }
  async renew(scope: ShortsScope, claim: LifecycleClaim, leaseMs = 120000) {
    const lease = this.lease(leaseMs);
    return this.locked(scope, claim, async (db, args) => {
      const [rows] = await db.query(
        `UPDATE shorts_lifecycle_jobs
        SET lease_until=clock_timestamp()+$7::integer*interval '1 millisecond'
        WHERE network=$1 AND contract=$2 AND id=$3 AND generation=$4 AND fence=$5 AND lease_token=$6
          AND lease_until>clock_timestamp() RETURNING id`,
        [...args, lease],
      );
      return rows.length === 1;
    });
  }

  async settle(
    scope: ShortsScope,
    claim: LifecycleClaim,
    result: LifecycleResult,
  ) {
    if (
      ![
        'checked',
        'publication_pending',
        'retention_pending',
        'reconciliation_required',
        'failed',
        'capacity_wait',
      ].includes(result)
    )
      throw new BadRequestException('Invalid lifecycle result');
    return this.locked(scope, claim, async (db, args) => {
      const [rows] = await db.query(
        `UPDATE shorts_lifecycle_jobs SET
      result=$7::text,checked_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,
      attempts=CASE WHEN $7='failed' THEN least(16,attempts+1) WHEN $7='capacity_wait' THEN attempts ELSE 0 END,
      next_at=clock_timestamp()+(CASE WHEN $7='failed' THEN least(300000,10000*power(2,least(attempts,5)))
        WHEN $7 IN ('publication_pending','capacity_wait') THEN 15000 ELSE 300000 END)*interval '1 millisecond'
      WHERE network=$1 AND contract=$2 AND id=$3 AND generation=$4 AND fence=$5 AND lease_token=$6
        AND lease_until>clock_timestamp() RETURNING id`,
        [...args, result],
      );
      return rows.length === 1;
    });
  }
}
