import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ShortsService } from './shorts.service';
import { ShortsMediaService } from './shorts-media.service';
import { ShortsDeliverySelectionService } from './shorts-delivery-selection.service';
import {
  PrivateCleanupProofSnapshot,
  PrivateCleanupSnapshot,
  ShortsPrivateInputCleanupJournalService,
} from './shorts-private-input-cleanup-journal.service';
import { shortsStorageScope } from './shorts-runtime-scope';
import { privateCleanupVerifications } from './shorts-private-cleanup-batch';

/** API-side byte/pin verifier; this process receives no deletion credentials. */
@Injectable()
export class ShortsPrivateInputCleanupVerifierService implements OnModuleDestroy {
  private readonly enabled =
    process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED === 'true';
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly shorts: ShortsService,
    private readonly media: ShortsMediaService,
    private readonly selections: ShortsDeliverySelectionService,
    private readonly journal: ShortsPrivateInputCleanupJournalService,
  ) {
    if (
      process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED !== undefined &&
      !['true', 'false'].includes(
        process.env.SHORTS_PRIVATE_INPUT_CLEANUP_ENABLED,
      )
    )
      throw new Error('Invalid private input cleanup flag');
  }
  async verify(operation: string, verification: string, parent?: AbortSignal) {
    return (
      await this.verifyMany(
        [{ operationId: operation, verificationId: verification }],
        parent,
      )
    )[0];
  }
  async verifyMany(input: unknown, parent?: AbortSignal) {
    const requests = privateCleanupVerifications(input);
    if (!this.enabled || this.shutdown.signal.aborted || this.pending.size >= 2)
      throw new ServiceUnavailableException(
        'Private input verification unavailable',
      );
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(300000),
      ...(parent ? [parent] : []),
    ]);
    const task = this.run(requests, signal);
    this.pending.add(task);
    try {
      return await task;
    } finally {
      this.pending.delete(task);
    }
  }
  private async run(
    requests: ReturnType<typeof privateCleanupVerifications>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const scope = shortsStorageScope(this.shorts.chain);
    const roots = new Map<string, PrivateCleanupSnapshot['records'][number]>();
    const proofs: {
      verificationId: string;
      snapshot: PrivateCleanupProofSnapshot;
    }[] = [];
    let retainedBytes = 0;
    for (const request of requests) {
      signal.throwIfAborted();
      // Only one bounded SQL snapshot is materialized at a time. Keep one copy
      // of each distinct immutable media root, not one copy per upload part.
      const snapshot = await this.journal.snapshot(scope, request.operationId);
      for (const root of snapshot.records) {
        if (!/^[a-f0-9]{64}$/.test(root.durabilityHash))
          throw new Error('Invalid private durability identity');
        if (roots.has(root.durabilityHash)) continue;
        retainedBytes += Buffer.byteLength(JSON.stringify(root));
        if (roots.size >= 256 || retainedBytes > 16777216)
          throw new Error('Private cleanup verification batch is too large');
        roots.set(root.durabilityHash, root);
      }
      proofs.push({
        verificationId: request.verificationId,
        snapshot: {
          operationId: snapshot.operationId,
          scope: snapshot.scope,
          stateHash: snapshot.stateHash,
          observedAt: snapshot.observedAt,
        },
      });
    }
    for (const root of roots.values()) {
      signal.throwIfAborted();
      const original = await this.shorts.ensurePlayable(root.shortId);
      const target = await this.selections.acknowledged(
        scope,
        original,
        root.sourceKey,
      );
      await this.media.verifyDurableDelivery(
        root.record,
        target.descriptor,
        target.prepared,
        signal,
      );
      await this.shorts.ensurePlayable(root.shortId);
    }
    signal.throwIfAborted();
    if (proofs.length === 1)
      return [
        await this.journal.verified(
          scope,
          proofs[0].snapshot.operationId,
          proofs[0].verificationId,
          proofs[0].snapshot,
        ),
      ];
    return this.journal.verifiedBatch(scope, proofs);
  }
  async onModuleDestroy() {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending]);
  }
}
