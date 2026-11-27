import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ShortsService } from './shorts.service';
import { ShortsMediaService } from './shorts-media.service';
import { ShortsDeliverySelectionService } from './shorts-delivery-selection.service';
import { ShortsDeliveryInputRetirementService } from './shorts-delivery-input-retirement.service';
import { shortsStorageScope } from './shorts-runtime-scope';

/** Verifies retained delivery before ending automatic input restoration. No deletion. */
@Injectable()
export class ShortsDeliveryRetirementService implements OnModuleDestroy {
  private readonly enabled =
    process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED === 'true';
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly shorts: ShortsService,
    private readonly media: ShortsMediaService,
    private readonly selections: ShortsDeliverySelectionService,
    private readonly retirements: ShortsDeliveryInputRetirementService,
  ) {
    if (
      process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED !== undefined &&
      !['true', 'false'].includes(
        process.env.SHORTS_DELIVERY_INPUT_RETIREMENT_ENABLED,
      )
    )
      throw new Error('Invalid input retirement flag');
  }
  async retireInputs(
    id: string,
    key: string,
    operation: string,
    parent?: AbortSignal,
  ) {
    if (this.shutdown.signal.aborted || this.pending.size >= 2)
      throw new ServiceUnavailableException('Input retirement unavailable');
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(300000),
      ...(parent ? [parent] : []),
    ]);
    const task = this.run(id, key, operation, signal);
    this.pending.add(task);
    try {
      return await task;
    } finally {
      this.pending.delete(task);
    }
  }
  private async run(
    id: string,
    key: string,
    operation: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const scope = shortsStorageScope(this.shorts.chain);
    const original = await this.shorts.ensurePlayable(id);
    const saved = await this.retirements.operation(scope, id, operation);
    if (saved) {
      await this.shorts.ensurePlayable(id);
      signal.throwIfAborted();
      return this.retirements.match(saved, key);
    }
    if (!this.enabled)
      throw new ServiceUnavailableException('Input retirement unavailable');
    const target = await this.selections.acknowledged(scope, original, key);
    await this.media.verifyDurableDelivery(
      target.record,
      target.descriptor,
      target.prepared,
      signal,
    );
    await this.shorts.ensurePlayable(id);
    signal.throwIfAborted();
    const receipt = await this.retirements.commit(scope, id, key, operation);
    await this.shorts.ensurePlayable(id);
    signal.throwIfAborted();
    return receipt;
  }
  async onModuleDestroy() {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending]);
  }
}
