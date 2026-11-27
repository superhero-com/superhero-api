import {
  Injectable,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ShortsService } from './shorts.service';
import { ShortsMediaService } from './shorts-media.service';
import { ShortsStreamingService } from './shorts-streaming.service';
import { ShortsDeliveryPackagesService } from './shorts-delivery-packages.service';
import { ShortsDeliveryInputRetirementService } from './shorts-delivery-input-retirement.service';
import { shortsStorageScope } from './shorts-runtime-scope';
import { ShortsDeliveryAcknowledgementService } from './shorts-delivery-acknowledgement.service';

/** Explicit candidate preparation. Current playback is never changed here. */
@Injectable()
export class ShortsDeliveryPreparationService implements OnModuleDestroy {
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly shorts: ShortsService,
    private readonly media: ShortsMediaService,
    private readonly streaming: ShortsStreamingService,
    private readonly packages: ShortsDeliveryPackagesService,
    @Optional()
    private readonly retirements?: ShortsDeliveryInputRetirementService,
    @Optional()
    private readonly acknowledgement?: ShortsDeliveryAcknowledgementService,
  ) {}
  async prepare(
    id: string,
    jobId: string,
    parent?: AbortSignal,
    authorize?: () => Promise<void>,
  ) {
    if (this.pending.size >= 2 || this.shutdown.signal.aborted)
      throw new ServiceUnavailableException('Delivery preparation unavailable');
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(300000),
      ...(parent ? [parent] : []),
    ]);
    const task = this.run(id, jobId, signal, authorize);
    this.pending.add(task);
    try {
      return await task;
    } finally {
      this.pending.delete(task);
    }
  }
  private async run(
    id: string,
    jobId: string,
    signal: AbortSignal,
    authorize?: () => Promise<void>,
  ) {
    signal.throwIfAborted();
    const candidate = await this.shorts.authorizedGeneration(id, jobId);
    const recheck = async () => {
      signal.throwIfAborted();
      await authorize?.();
      const current = await this.shorts.authorizedGeneration(id, jobId);
      if (current.sourceKey !== candidate.sourceKey)
        throw new Error('Candidate source changed');
      signal.throwIfAborted();
    };
    await recheck();
    const retired = await this.retirements?.get(
      shortsStorageScope(this.shorts.chain),
      id,
      candidate.sourceKey,
    );
    if (retired) {
      if (
        retired.inputCid !== candidate.record.derivatives?.cid ||
        retired.generationJobId !== jobId
      )
        throw new Error('Input retirement identity mismatch');
      const retained = await this.packages.get(candidate.descriptor);
      if (!retained)
        throw new Error('Retired delivery acknowledgement missing');
      await this.media.verifyDurableDelivery(
        candidate.record,
        candidate.descriptor,
        retained,
        signal,
      );
    } else {
      await recheck();
      await this.media.ensurePinned(candidate.record, signal);
    }
    await recheck();
    const prepared = await this.streaming.prepareGeneration(
      candidate.descriptor,
      signal,
    );
    await recheck();
    if (!prepared)
      return { status: 'preparing' as const, sourceKey: candidate.sourceKey };
    const verified =
      this.acknowledgement && process.env.SHORTS_IPFS_EXPIRING_WRITES === 'true'
        ? prepared
        : await this.media.verifyPreparedDelivery(
            candidate.record,
            candidate.descriptor,
            prepared,
            signal,
          );
    await recheck();
    if (this.acknowledgement)
      await this.acknowledgement.acknowledge(
        candidate.record,
        candidate.descriptor,
        verified,
        recheck,
        signal,
      );
    else await this.packages.acknowledge(candidate.descriptor, verified);
    await recheck();
    return { status: 'ready' as const, sourceKey: candidate.sourceKey };
  }
  async onModuleDestroy() {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending]);
  }
}
