import {
  ConflictException,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ShortsService } from './shorts.service';
import { ShortsMediaService } from './shorts-media.service';
import {
  DeliveryExpectation,
  DeliverySelectionKind,
  ShortsDeliverySelectionService,
} from './shorts-delivery-selection.service';
import { shortsStorageScope } from './shorts-runtime-scope';

/** Trusted operations coordinator. No creator-controlled HTTP writer. */
@Injectable()
export class ShortsDeliveryActivationService implements OnModuleDestroy {
  private readonly enabled =
    process.env.SHORTS_DELIVERY_SELECTION_ENABLED === 'true';
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly shorts: ShortsService,
    private readonly media: ShortsMediaService,
    private readonly selections: ShortsDeliverySelectionService,
  ) {
    if (
      process.env.SHORTS_DELIVERY_SELECTION_ENABLED !== undefined &&
      !['true', 'false'].includes(process.env.SHORTS_DELIVERY_SELECTION_ENABLED)
    )
      throw new Error('Invalid delivery selection flag');
  }
  async select(
    id: string,
    nextKey: string,
    expected: DeliveryExpectation,
    operation: string,
    kind: DeliverySelectionKind = 'activate',
    parent?: AbortSignal,
  ) {
    if (this.pending.size >= 2 || this.shutdown.signal.aborted)
      throw new ServiceUnavailableException('Delivery selection unavailable');
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(300000),
      ...(parent ? [parent] : []),
    ]);
    const task = this.run(id, nextKey, expected, operation, kind, signal);
    this.pending.add(task);
    try {
      return await task;
    } finally {
      this.pending.delete(task);
    }
  }
  private async run(
    id: string,
    nextKey: string,
    expected: DeliveryExpectation,
    operation: string,
    kind: DeliverySelectionKind,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const scope = shortsStorageScope(this.shorts.chain);
    let original = await this.shorts.ensurePlayable(id);
    const saved = await this.selections.operation(scope, id, operation);
    if (saved) {
      await this.shorts.ensurePlayable(id);
      signal.throwIfAborted();
      return this.selections.match(saved, expected, nextKey, kind);
    }
    if (!this.enabled && kind !== 'rollback')
      throw new ServiceUnavailableException('Delivery selection unavailable');
    const current = await this.selections.state(scope, original);
    if (
      current.sourceKey !== expected.sourceKey ||
      current.revision !== expected.revision ||
      nextKey === current.sourceKey
    )
      throw new ConflictException('Active delivery changed');
    const target = await this.selections.acknowledged(scope, original, nextKey);
    await this.media.verifyDurableDelivery(
      target.record,
      target.descriptor,
      target.prepared,
      signal,
    );
    original = await this.shorts.ensurePlayable(id);
    signal.throwIfAborted();
    if (kind === 'activate') {
      const previous = await this.selections.acknowledged(
        scope,
        original,
        expected.sourceKey,
      );
      await this.media.verifyDurableDelivery(
        previous.record,
        previous.descriptor,
        previous.prepared,
        signal,
      );
    }
    // A rollback verifies its retained target, even if the current package is
    // damaged. History and all references to the damaged version are preserved.
    await this.shorts.ensurePlayable(id);
    signal.throwIfAborted();
    const receipt = await this.selections.commit(
      scope,
      id,
      expected,
      nextKey,
      operation,
      kind,
    );
    await this.shorts.ensurePlayable(id);
    signal.throwIfAborted();
    return receipt;
  }
  async onModuleDestroy() {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending]);
  }
}
