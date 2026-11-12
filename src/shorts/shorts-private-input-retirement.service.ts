import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ShortsService } from './shorts.service';
import { ShortsMediaService } from './shorts-media.service';
import { ShortsDeliverySelectionService } from './shorts-delivery-selection.service';
import { ShortsPrivateInputRetirementsService } from './shorts-private-input-retirements.service';
import { ShortsSourceService } from './shorts-source.service';
import { ShortsPrivateObjectsService } from './shorts-private-objects.service';
import { shortsStorageScope } from './shorts-runtime-scope';

/** Captures authenticated processing references after verifying durable delivery. No deletion. */
@Injectable()
export class ShortsPrivateInputRetirementService implements OnModuleDestroy {
  private readonly enabled =
    process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED === 'true';
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly shorts: ShortsService,
    private readonly media: ShortsMediaService,
    private readonly selections: ShortsDeliverySelectionService,
    private readonly retirements: ShortsPrivateInputRetirementsService,
    private readonly sources: ShortsSourceService,
    private readonly objects: ShortsPrivateObjectsService,
  ) {
    if (
      process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED !== undefined &&
      !['true', 'false'].includes(
        process.env.SHORTS_PRIVATE_INPUT_RETIREMENT_ENABLED,
      )
    )
      throw new Error('Invalid private input retirement flag');
  }

  async retireInputs(
    id: string,
    key: string,
    operation: string,
    parent?: AbortSignal,
  ) {
    if (this.shutdown.signal.aborted || this.pending.size >= 2)
      throw new ServiceUnavailableException(
        'Private input retirement unavailable',
      );
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
      throw new ServiceUnavailableException(
        'Private input retirement unavailable',
      );
    const snapshot = await this.retirements.snapshot(scope, id, key);
    const target = await this.selections.acknowledged(scope, original, key);
    await this.media.verifyDurableDelivery(
      snapshot.record,
      target.descriptor,
      target.prepared,
      signal,
    );
    const manifest = await this.sources.manifestDocument(
      scope,
      {
        id: snapshot.resourceId,
        creator: snapshot.record.creator,
        input: snapshot.record.privateMedia.source,
      },
      signal,
    );
    for (const ref of [...snapshot.refs, ...manifest.parts])
      this.objects.validateReference(scope, ref);
    await this.shorts.ensurePlayable(id);
    signal.throwIfAborted();
    const receipt = await this.retirements.commit(
      scope,
      id,
      key,
      operation,
      snapshot.rootHash,
      manifest.bytes.toString('utf8'),
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
