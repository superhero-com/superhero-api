import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ShortsChainService } from './shorts-chain.service';
import { ShortsService } from './shorts.service';
import { ShortsMediaService } from './shorts-media.service';

@Injectable()
export class ShortsHostingService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ShortsHostingService.name);
  private timer: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly chain: ShortsChainService,
    private readonly media: ShortsMediaService,
    private readonly shorts: ShortsService,
  ) {}
  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      void this.reconcile();
    }, 60000);
    this.timer.unref();
    void this.reconcile();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }
  async reconcile() {
    if (this.running) return;
    this.running = true;
    try {
      await this.chain.serial(async () => {
        const pinned = await this.media.pins();
        const active = new Map<
          string,
          (typeof this.chain.state.shorts)[number]
        >();
        for (const short of this.chain.state.shorts) {
          const qid = await this.chain.read('get_pending', [short.id]);
          if (qid !== undefined) {
            const q = await this.chain.read('get_quote', [qid]);
            if (q.funded && !q.complete && Number(q.deadline) >= Date.now()) {
              await this.shorts.fund(short.creator, String(qid));
            }
          }
          const video = await this.chain.read('get_short', [short.id]);
          if (
            video &&
            !video.withdrawn &&
            BigInt(video.until) > BigInt(Date.now())
          )
            active.set(short.cid, short);
        }
        // Preserve a CID if another active Short uses the same package.
        for (const short of this.chain.state.shorts) {
          if (pinned.has(short.cid) && !active.has(short.cid)) {
            await this.media.unpin(short.cid);
            pinned.delete(short.cid);
          }
        }
        for (const [cid, short] of active)
          if (!this.media.hasAllPins(cid)) await this.media.pin(short);
      });
      if (this.shorts.demoAutoApprove) return;
      // Feed inspection must not delay paid hosting or hold the transaction queue.
      for (const short of this.chain.state.shorts) {
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
    } finally {
      this.running = false;
    }
  }
}
