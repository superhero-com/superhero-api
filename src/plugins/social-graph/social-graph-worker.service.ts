import { SocialGraphOutboxService } from './social-graph-outbox.service';
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { WebSocketService } from '@/ae/websocket.service';
import { SocialGraphGateway } from './social-graph.gateway';
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
export class SocialGraphWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SocialGraphWorkerService.name);
  private running = false;
  private stopped = false;
  private requested = false;
  private scheduled?: NodeJS.Immediate;
  private retry?: NodeJS.Timeout;
  private retryDelay = 1000;
  private blockHint?: { hash: string; height: number; expires: number };
  private unsubscribers: (() => void)[] = [];
  constructor(
    private readonly db: DataSource,
    private readonly ae: AeSdkService,
    private readonly graph: SocialGraphService,
    private readonly snapshots: SocialGraphSnapshotService,
    private readonly catchup: SocialGraphCatchupService,
    private readonly reconcile: SocialGraphReconcileService,
    private readonly projection: SocialGraphProjectionService,
    private readonly outbox: SocialGraphOutboxService,
    private readonly websocket: WebSocketService,
    private readonly gateway: SocialGraphGateway,
  ) {}

  onModuleInit() {
    if (
      process.env.SOCIAL_GRAPH_WORKER_ENABLED === 'false' ||
      !this.graph.isConfigured()
    )
      return;
    this.unsubscribers = [
      this.websocket.subscribeForMicroBlocksUpdates(
        (block) => this.requestSync(block),
        'node',
      ),
      this.websocket.subscribeForKeyBlocksUpdates(
        (block) => this.requestSync(block),
        'node',
      ),
      this.websocket.subscribeForConnection(() => this.requestSync()),
    ];
    this.requestSync();
  }

  // Events only wake one serialized consumer. The canonical node stream decides
  // order and coverage, so duplicate/out-of-order websocket hints cannot skip edges.
  requestSync(block?: { hash?: string; height?: number | string }): void {
    if (
      this.stopped ||
      process.env.SOCIAL_GRAPH_WORKER_ENABLED === 'false' ||
      !this.graph.isConfigured()
    )
      return;
    if (
      block?.hash &&
      /^(mh_|kh_)/.test(block.hash) &&
      Number.isSafeInteger(Number(block.height)) &&
      Number(block.height) >= 0
    ) {
      const height = Number(block.height);
      if (!this.blockHint || height >= this.blockHint.height) {
        this.blockHint = {
          hash: block.hash,
          height,
          expires: Date.now() + 30000,
        };
      }
    }
    this.requested = true;
    if (this.running || this.scheduled || this.retry) return;
    this.scheduled = setImmediate(async () => {
      this.scheduled = undefined;
      this.requested = false;
      let result: 'idle' | 'progress' | 'retry';
      try {
        result = await this.tick();
      } catch (error) {
        this.logger.error('Social graph pass failed', error);
        result = 'retry';
      }
      if (this.stopped) return;
      if (result === 'retry') {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.requestSync();
        }, this.retryDelay);
        this.retry.unref?.();
        this.retryDelay = Math.min(30000, this.retryDelay * 2);
      } else {
        this.retryDelay = 1000;
        if (result === 'progress' || this.requested) this.requestSync();
      }
    });
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    if (this.retry) clearTimeout(this.retry);
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers = [];
  }

  async tick(): Promise<'idle' | 'progress' | 'retry'> {
    if (
      process.env.SOCIAL_GRAPH_WORKER_ENABLED === 'false' ||
      !this.graph.isConfigured() ||
      this.running
    )
      return 'idle';
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
      if (!locked) return 'retry';
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
        await this.gateway.changed(scope);
        return 'progress';
      }
      await reader.assertCanonical(
        latest.snapshot_hash,
        latest.snapshot_height,
      );
      if (latest.synced_hash)
        await reader.assertCanonical(latest.synced_hash, latest.synced_height);
      if (latest.state === 'importing') {
        await this.snapshots.step(scope, reader);
        return 'progress';
      }
      const stream = new SocialGraphNodeStream(this.ae.sdk.getContext().onNode);
      const start = {
        hash: latest.synced_hash ?? latest.snapshot_hash,
        height: latest.synced_height ?? latest.snapshot_height,
      };
      if (latest.sync_end_height == null) {
        const top = await this.ae.sdk.getContext().onNode.getTopHeader();
        if (BigInt(top.height) < BigInt(start.height))
          throw new GraphReorgError('Node tip moved behind the checkpoint');
        if (top.hash === start.hash) {
          // MDW can announce a block before the read node exposes it. Retry that
          // notification briefly; do not turn an idle consumer into a chain poll.
          const hint = this.blockHint;
          if (
            hint &&
            hint.hash !== start.hash &&
            hint.height >= Number(start.height) &&
            hint.expires > Date.now()
          ) {
            const generation = await this.ae.sdk
              .getContext()
              .onNode.getGenerationByHeight(hint.height);
            const startIndex = generation.microBlocks.indexOf(
              start.hash as any,
            );
            const hintIndex = generation.microBlocks.indexOf(hint.hash as any);
            const alreadyCovered =
              hint.height === Number(start.height) &&
              (hint.hash === generation.keyBlock.hash ||
                (hintIndex >= 0 && startIndex >= hintIndex));
            if (!alreadyCovered) return 'retry';
          }
          this.blockHint = undefined;
          if (latest.state !== 'ready' || latest.notify_from_height == null) {
            await runner.query(
              `UPDATE social_graph_projection_scopes SET state='ready',synced_hash=$4,synced_height=$5,
              notify_from_height=COALESCE(notify_from_height,$5)
              WHERE network=$1 AND contract=$2 AND generation=$3`,
              [
                scope.network,
                scope.contract,
                scope.generation,
                start.hash,
                start.height,
              ],
            );
            await this.gateway.changed(scope);
          }
          const checked = await this.reconcile.step(scope, reader, 10);
          const delivered = await this.outbox.dispatch(scope);
          return checked === 10 || delivered === 10 ? 'progress' : 'idle';
        }
        // Finish intervening generations, then consume the current microblock
        // prefix immediately; no extra key-block confirmation delay.
        const end =
          BigInt(top.height) > BigInt(start.height)
            ? await stream.anchor((BigInt(start.height) + 1n).toString())
            : { hash: top.hash, height: String(top.height) };
        await this.catchup.begin(scope, end, FIRST_NODE_CURSOR);
        return 'progress';
      }
      const page = await stream.page(
        reader,
        start,
        { hash: latest.sync_end_hash, height: latest.sync_end_height },
        latest.sync_cursor,
      );
      await this.catchup.applyPage(scope, page);
      const events = page.transactions.flatMap((tx) => tx.events);
      if (events.length) {
        const accounts = [
          ...new Set(
            events.flatMap((event) =>
              event.changes.flatMap((change) => [change.from, change.to]),
            ),
          ),
        ];
        await this.gateway.changed(
          scope,
          events.some((event) => !event.changes.length) ? undefined : accounts,
        );
      }
      return 'progress';
    } catch (error) {
      if (
        scope &&
        (error instanceof GraphReorgError ||
          (error instanceof Error &&
            error.message === 'Snapshot is no longer canonical'))
      ) {
        await this.projection.invalidateAfterReorg(scope);
        await this.gateway.changed(scope);
        return 'progress';
      }
      this.logger.error(
        `Social graph worker stopped this pass: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'retry';
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
