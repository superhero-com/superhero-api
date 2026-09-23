import { SocialGraphOutboxService } from './social-graph-outbox.service';
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { SocialGraphService } from './social-graph.service';
import { SocialGraphSnapshotService } from './social-graph-snapshot.service';
import { SocialGraphCatchupService } from './social-graph-catchup.service';
import { SocialGraphReconcileService } from './social-graph-reconcile.service';
import {
  SocialGraphProjectionService,
  ProjectionScope,
} from './social-graph-projection.service';
import {
  FIRST_NODE_CURSOR,
  GraphReorgError,
  SocialGraphNodeStream,
} from './social-graph-node-stream';

@Injectable()
export class SocialGraphWorkerService {
  private readonly logger = new Logger(SocialGraphWorkerService.name);
  private running = false;
  constructor(
    private readonly db: DataSource,
    private readonly ae: AeSdkService,
    private readonly graph: SocialGraphService,
    private readonly snapshots: SocialGraphSnapshotService,
    private readonly catchup: SocialGraphCatchupService,
    private readonly reconcile: SocialGraphReconcileService,
    private readonly projection: SocialGraphProjectionService,
    private readonly outbox: SocialGraphOutboxService,
  ) {}

  @Interval(3000)
  async tick() {
    if (
      process.env.SOCIAL_GRAPH_WORKER_ENABLED === 'false' ||
      !this.graph.isConfigured() ||
      this.running
    )
      return;
    this.running = true;
    let scope: ProjectionScope | undefined;
    const runner = this.db.createQueryRunner();
    let connection: { end(): Promise<void> } | undefined;
    let locked = false;
    let lockName: string | undefined;
    try {
      const reader = this.graph.getReader();
      await reader.verifyIdentity();
      lockName = `social-graph:${reader.identity.network}:${reader.identity.contract}`;
      connection = await runner.connect();
      locked = (
        await runner.query(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
          [lockName],
        )
      )[0].locked;
      if (!locked) return;
      const latest = (
        await runner.query(
          'SELECT * FROM social_graph_projection_scopes WHERE network=$1 AND contract=$2 ORDER BY generation DESC LIMIT 1',
          [reader.identity.network, reader.identity.contract],
        )
      )[0];
      scope = { ...reader.identity, generation: latest?.generation ?? '1' };
      if (!latest || latest.state === 'rebuilding') {
        if (latest)
          scope.generation = (BigInt(latest.generation) + 1n).toString();
        await this.snapshots.begin(scope, reader);
        return;
      }
      await reader.assertCanonical(
        latest.snapshot_hash,
        latest.snapshot_height,
      );
      if (latest.synced_hash)
        await reader.assertCanonical(latest.synced_hash, latest.synced_height);
      if (latest.state === 'importing') {
        await this.snapshots.step(scope, reader);
        return;
      }
      const stream = new SocialGraphNodeStream(this.ae.sdk.getContext().onNode);
      const start = {
        hash: latest.synced_hash ?? latest.snapshot_hash,
        height: latest.synced_height ?? latest.snapshot_height,
      };
      if (latest.sync_end_height == null) {
        if (latest.state === 'ready') {
          await this.reconcile.step(scope, reader, 10);
          await this.outbox.dispatch(scope);
        }
        const policy = await reader.policy();
        if (
          latest.state === 'ready' &&
          latest.notify_from_height == null &&
          BigInt(start.height) >= BigInt(policy.height) - 1n
        ) {
          await runner.query(
            `UPDATE social_graph_projection_scopes SET notify_from_height=$4
            WHERE network=$1 AND contract=$2 AND generation=$3 AND notify_from_height IS NULL`,
            [scope.network, scope.contract, scope.generation, start.height],
          );
        }
        // Keep one closed generation behind the chain tip. Reorg checks remain
        // necessary; this delay is not a finality guarantee.
        if (BigInt(policy.height) <= BigInt(start.height) + 1n) return;
        const end = await stream.anchor((BigInt(start.height) + 1n).toString());
        await this.catchup.begin(scope, end, FIRST_NODE_CURSOR);
        return;
      }
      const page = await stream.page(
        reader,
        start,
        { hash: latest.sync_end_hash, height: latest.sync_end_height },
        latest.sync_cursor,
      );
      await this.catchup.applyPage(scope, page);
    } catch (error) {
      if (
        scope &&
        (error instanceof GraphReorgError ||
          (error instanceof Error &&
            error.message === 'Snapshot is no longer canonical'))
      )
        await this.projection.invalidateAfterReorg(scope);
      this.logger.error(
        `Social graph worker stopped this pass: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try {
        if (locked)
          await runner.query(
            'SELECT pg_advisory_unlock(hashtextextended($1,0))',
            [lockName],
          );
      } catch (error) {
        // Never return a session with an unreleased advisory lock to the pool.
        // Closing only our lock connection releases that lock on the server.
        await connection?.end();
        this.logger.error(
          'Social graph worker discarded its lock connection after unlock failure',
        );
      } finally {
        try {
          await runner.release();
        } finally {
          this.running = false;
        }
      }
    }
  }
}
