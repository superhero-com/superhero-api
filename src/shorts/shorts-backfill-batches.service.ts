import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import { ShortsScope } from './shorts-metadata.service';
import {
  BackfillPlan,
  backfillHash,
  backfillRequest,
} from './shorts-backfill-plan';

export type BackfillPhase =
  'planned' | 'preparing' | 'ready' | 'activated' | 'failed' | 'cancelled';
export interface BackfillItem {
  ordinal: number;
  short_id: string;
  job_id: string;
  operation_id: string;
  plan: BackfillPlan['items'][number];
  phase: BackfillPhase;
  failures: number;
  source_key?: string;
}
type Request = ReturnType<typeof backfillRequest> & { planHash: string };
export interface BackfillBatch {
  id: string;
  request: Request;
  plan: BackfillPlan;
  status: 'running' | 'completed' | 'cancelled';
  created_at: Date;
  expired: boolean;
  items: BackfillItem[];
}

/** Durable operations state. No creator routes, worker grants or media bytes. */
@Injectable()
export class ShortsBackfillBatchesService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}
  private args(scope: ShortsScope, id?: string) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract) ||
      (id !== undefined &&
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
    )
      throw new Error('Invalid backfill identity');
    return [scope.network, scope.contract, ...(id ? [id] : [])];
  }
  private async transaction<T>(
    work: (db: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'",
      );
      return work(db);
    });
  }
  async get(scope: ShortsScope, id: string): Promise<BackfillBatch> {
    const args = this.args(scope, id);
    const [row] = await this.db.query(
      "SELECT id,request,plan,status,created_at,created_at<=clock_timestamp()-interval '24 hours' AS expired FROM shorts_backfill_batches WHERE network=$1 AND contract=$2 AND id=$3",
      args,
    );
    if (!row) throw new NotFoundException('Backfill batch unavailable');
    const items = await this.db.query(
      'SELECT ordinal,short_id,job_id,operation_id,plan,phase,failures,source_key,error_code FROM shorts_backfill_items WHERE network=$1 AND contract=$2 AND batch_id=$3 ORDER BY ordinal',
      args,
    );
    return { ...row, items };
  }
  match(batch: BackfillBatch, request: Request) {
    // JSONB may reorder object properties, so compare normalized request values.
    if (
      backfillHash(backfillRequest(batch.request.ids, batch.request.budget)) !==
        backfillHash(backfillRequest(request.ids, request.budget)) ||
      batch.request.planHash !== request.planHash
    )
      throw new ConflictException('Backfill operation was already used');
    return batch;
  }
  async create(
    scope: ShortsScope,
    id: string,
    request: Request,
    plan: BackfillPlan,
  ) {
    const args = this.args(scope, id);
    await this.transaction(async (db) => {
      await db.query(
        'SELECT contract FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
        args.slice(0, 2),
      );
      const [old] = await db.query(
        'SELECT * FROM shorts_backfill_batches WHERE network=$1 AND contract=$2 AND id=$3',
        args,
      );
      if (old) {
        this.match(old, request);
        return;
      }
      const [active] = await db.query(
        "SELECT id FROM shorts_backfill_batches WHERE network=$1 AND contract=$2 AND status='running'",
        args.slice(0, 2),
      );
      if (active)
        throw new ConflictException('A backfill batch is already running');
      await db.query(
        'INSERT INTO shorts_backfill_batches(network,contract,id,request,plan) VALUES($1,$2,$3,$4,$5)',
        [...args, request, plan],
      );
      for (const [ordinal, item] of plan.items.entries()) {
        await db.query(
          `INSERT INTO shorts_backfill_items(network,contract,batch_id,ordinal,short_id,job_id,operation_id,plan)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            ...args,
            ordinal,
            item.id,
            `backfill-${randomUUID()}`,
            randomUUID(),
            item,
          ],
        );
      }
    });
    return this.get(scope, id);
  }
  async active(scope: ShortsScope) {
    const [row] = await this.db.query(
      "SELECT id FROM shorts_backfill_batches WHERE network=$1 AND contract=$2 AND status='running'",
      this.args(scope),
    );
    return row?.id as string | undefined;
  }
  async held(scope: ShortsScope, id: string) {
    const [{ held }] = await this.db.query(
      'SELECT EXISTS(SELECT FROM shorts_retention_holds WHERE network=$1 AND contract=$2 AND resource_id=$3 AND released_at IS NULL) AS held',
      [...this.args(scope), id],
    );
    return held as boolean;
  }
  async foreground(scope: ShortsScope) {
    const [{ busy }] = await this.db.query(
      "SELECT EXISTS(SELECT FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND delivery_short_id IS NULL AND status IN ('queued','processing')) AS busy",
      this.args(scope),
    );
    return busy as boolean;
  }
  async job(scope: ShortsScope, job: string) {
    const [row] = await this.db.query(
      'SELECT status,error_code FROM shorts_ingestion WHERE network=$1 AND contract=$2 AND id=$3',
      [...this.args(scope), job],
    );
    return row as { status: string; error_code?: string } | undefined;
  }
  async claim(scope: ShortsScope, id: string) {
    const token = randomUUID();
    const rows = await this.transaction((db) =>
      db.query(
        `WITH changed AS (UPDATE shorts_backfill_batches
      SET lease_token=$4,lease_until=clock_timestamp()+interval '360 seconds'
      WHERE network=$1 AND contract=$2 AND id=$3 AND status='running'
      AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING id) SELECT * FROM changed`,
        [...this.args(scope, id), token],
      ),
    );
    return rows.length ? token : undefined;
  }
  async owned(scope: ShortsScope, id: string, token: string) {
    const [{ owned }] = await this.transaction((db) =>
      db.query(
        `SELECT EXISTS(SELECT FROM shorts_backfill_batches
      WHERE network=$1 AND contract=$2 AND id=$3 AND status='running' AND lease_token=$4 AND lease_until>clock_timestamp()) AS owned`,
        [...this.args(scope, id), token],
      ),
    );
    return owned as boolean;
  }
  private async stopJob(db: EntityManager, scope: ShortsScope, job: string) {
    await db.query(
      `UPDATE shorts_ingestion SET status='cancelled',lease_token=NULL,lease_until=NULL,error_code='backfill_cancelled',updated_at=clock_timestamp()
      WHERE network=$1 AND contract=$2 AND id=$3 AND delivery_short_id IS NOT NULL AND status IN ('queued','processing')`,
      [...this.args(scope), job],
    );
  }
  async finish(
    scope: ShortsScope,
    id: string,
    token: string,
    item?: BackfillItem,
    change?: { phase: BackfillPhase; sourceKey?: string; failed?: boolean },
  ) {
    await this.transaction(async (db) => {
      const args = this.args(scope, id);
      await db.query(
        'SELECT contract FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
        args.slice(0, 2),
      );
      const [owned] = await db.query(
        `SELECT id FROM shorts_backfill_batches WHERE network=$1 AND contract=$2 AND id=$3
        AND status='running' AND lease_token=$4 AND lease_until>clock_timestamp() FOR UPDATE`,
        [...args, token],
      );
      if (!owned) throw new ConflictException('Backfill claim changed');
      if (item && change) {
        const failed = change.failed === true,
          exhausted = failed && item.failures >= 2;
        const phase = exhausted ? 'failed' : change.phase;
        await db.query(
          `UPDATE shorts_backfill_items SET phase=$5,source_key=coalesce(source_key,$6),failures=failures+$7,error_code=$8
          WHERE network=$1 AND contract=$2 AND batch_id=$3 AND ordinal=$4 AND phase=$9`,
          [
            ...args,
            item.ordinal,
            phase,
            change.sourceKey ?? null,
            failed ? 1 : 0,
            failed ? 'stage_failed' : null,
            item.phase,
          ],
        );
        if (phase === 'failed') await this.stopJob(db, scope, item.job_id);
      }
      await db.query(
        `UPDATE shorts_backfill_batches SET lease_token=NULL,lease_until=NULL,
        status=CASE WHEN EXISTS(SELECT FROM shorts_backfill_items WHERE network=$1 AND contract=$2 AND batch_id=$3
          AND phase NOT IN ('activated','failed','cancelled')) THEN 'running' ELSE 'completed' END
        WHERE network=$1 AND contract=$2 AND id=$3`,
        args,
      );
    });
  }
  async cancel(scope: ShortsScope, id: string) {
    await this.transaction(async (db) => {
      const args = this.args(scope, id);
      await db.query(
        'SELECT contract FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
        args.slice(0, 2),
      );
      const [batch] = await db.query(
        'SELECT status FROM shorts_backfill_batches WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
        args,
      );
      if (!batch) throw new NotFoundException('Backfill batch unavailable');
      if (batch.status !== 'running') return;
      // The activation INSERT takes a share lock on this same batch row.
      // An already committed selection stays activated even after a lost reply.
      await db.query(
        `UPDATE shorts_backfill_items i SET phase=CASE WHEN EXISTS(SELECT FROM shorts_delivery_selections s WHERE s.operation_id=i.operation_id)
        THEN 'activated' ELSE 'cancelled' END WHERE network=$1 AND contract=$2 AND batch_id=$3 AND phase NOT IN ('activated','failed','cancelled')`,
        args,
      );
      const jobs = await db.query(
        'SELECT job_id FROM shorts_backfill_items WHERE network=$1 AND contract=$2 AND batch_id=$3',
        args,
      );
      for (const job of jobs) await this.stopJob(db, scope, job.job_id);
      await db.query(
        "UPDATE shorts_backfill_batches SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE network=$1 AND contract=$2 AND id=$3",
        args,
      );
    });
    return this.get(scope, id);
  }
}
