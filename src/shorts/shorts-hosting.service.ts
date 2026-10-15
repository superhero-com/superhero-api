import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ShortsChainService } from './shorts-chain.service';
import { ShortsService } from './shorts.service';
import { ShortsMediaService } from './shorts-media.service';
import { officialContentPolicy } from './shorts-eligibility';
import { ShortsRecordsService } from './shorts-records.service';

@Injectable()
export class ShortsHostingService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ShortsHostingService.name);
  private timer: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;
  private readonly shutdown = new AbortController();
  constructor(
    private readonly chain: ShortsChainService,
    private readonly media: ShortsMediaService,
    private readonly shorts: ShortsService,
    private readonly records: ShortsRecordsService = new ShortsRecordsService(
      chain,
    ),
  ) {}
  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      void this.reconcile();
    }, 60000);
    this.timer.unref();
    void this.reconcile();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    this.shutdown.abort();
    await this.pending;
  }
  reconcile() {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.runReconcile().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async runReconcile() {
    try {
      await this.chain.serial(async () => {
        const pinned = await this.media.pins();
        const active = new Map<
          string,
          (typeof this.chain.state.shorts)[number]
        >();
        const retained = new Set<string>();
        // Prepared drafts may register while network calls below are pending.
        // Keep this pass stable; new drafts enter the next reconciliation pass.
        const records = await this.records.all();
        for (let short of records) {
          if (this.stopped) return;
          short = await this.records.get(short.id);
          if (
            !officialContentPolicy(short, this.shorts.demoAutoApprove).publish
          ) {
            // Deny delivery/publication immediately, but keep existing private
            // evidence until retention/appeal policy authorizes its deletion.
            if (short.publication !== 'withdrawn' && pinned.has(short.cid))
              retained.add(short.cid);
            continue;
          }
          let video = await this.chain.read(
            'get_short',
            [short.id],
            this.shutdown.signal,
          );
          if (
            short.publication === 'pending' ||
            (!video && short.publication === 'published')
          ) {
            try {
              await this.shorts.publish(short.creator, short.id);
            } catch {
              this.logger.warn(`Publication will retry: ${short.id}`);
            }
          }
          video = await this.chain.read(
            'get_short',
            [short.id],
            this.shutdown.signal,
          );
          if (video && !video.withdrawn) active.set(short.cid, short);
          // Never remove storage for a submitted publication whose outcome is uncertain.
          if (!video && ['pending', 'published'].includes(short.publication))
            active.set(short.cid, short);
        }
        // Preserve a CID if another active Short uses the same package.
        for (const short of records) {
          if (
            pinned.has(short.cid) &&
            !active.has(short.cid) &&
            !retained.has(short.cid)
          ) {
            await this.media.unpin(short.cid);
            pinned.delete(short.cid);
          }
        }
        for (const [cid, short] of active)
          if (
            officialContentPolicy(
              await this.records.get(short.id),
              this.shorts.demoAutoApprove,
            ).publish &&
            !this.media.hasPin(cid)
          )
            await this.media.pin(short);
      });
      if (this.stopped || this.shorts.demoAutoApprove) return;
      // Invalidate review before awaiting scans; never reuse an old approval.
      for (const short of await this.records.all()) {
        if (this.stopped) return;
        if (
          !short.safety ||
          (short.safety.status === 'error' &&
            short.safety.checkedAt < Date.now() - 60000)
        )
          await this.shorts.rescan(short.id);
      }
    } catch (error) {
      this.logger.warn(
        `Local hosting reconciliation will retry: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
