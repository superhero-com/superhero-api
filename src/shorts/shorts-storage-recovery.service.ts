import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ShortsStorageRecoveriesService,
  StorageRecoveryKind,
} from './shorts-storage-recoveries.service';
import { ShortsPinTransfersService } from './shorts-pin-transfers.service';
import { ShortsInputReclamationPermitsService } from './shorts-input-reclamation-permits.service';
import { ShortsInputReclamationService } from './shorts-input-reclamation.service';
import { ShortsMediaService } from './shorts-media.service';

/** Observe an already recovered node. Never restart it, resend a write, or publish media. */
@Injectable()
export class ShortsStorageRecoveryService implements OnModuleDestroy {
  private readonly enabled: boolean;
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly recoveries: ShortsStorageRecoveriesService,
    private readonly pins: ShortsPinTransfersService,
    private readonly unpins: ShortsInputReclamationPermitsService,
    private readonly reclamation: ShortsInputReclamationService,
    private readonly media: ShortsMediaService,
  ) {
    const flag = process.env.SHORTS_STORAGE_RECOVERY_ENABLED ?? 'false';
    if (!['true', 'false'].includes(flag))
      throw new Error('Invalid storage recovery flag');
    this.enabled = flag === 'true';
    if (this.enabled && process.env.SHORTS_IPFS_EXPIRING_WRITES !== 'true')
      throw new Error('Storage recovery requires expiring writers');
  }
  async recover(
    kind: StorageRecoveryKind,
    operation: string,
    parent?: AbortSignal,
  ) {
    if (this.shutdown.signal.aborted || this.pending.size >= 2)
      throw new ServiceUnavailableException('Storage recovery unavailable');
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(600000),
      ...(parent ? [parent] : []),
    ]);
    signal.throwIfAborted();
    const task = this.observe(kind, operation, signal).catch(async (error) => {
      // Another coordinator, or a lost commit acknowledgement, may already have finished it.
      const saved = await this.recoveries.get(kind, operation);
      if (saved) return saved;
      throw error;
    });
    this.pending.add(task);
    try {
      return await task;
    } finally {
      this.pending.delete(task);
    }
  }
  private async observe(
    kind: StorageRecoveryKind,
    operation: string,
    signal: AbortSignal,
  ) {
    const saved = await this.recoveries.get(kind, operation);
    if (saved) return saved;
    if (!this.enabled)
      throw new ServiceUnavailableException('Storage recovery is disabled');
    const authority =
      kind === 'pin'
        ? await this.pins.get(operation)
        : await this.unpins.get(operation);
    if (!authority?.storage)
      throw new Error('Recovery requires previously bound storage authority');
    if (kind === 'pin' && !['issued', 'uncertain'].includes(authority.state))
      throw new Error('Pin recovery requires an unresolved outcome');
    if (Date.parse(authority.quietUntil) > Date.now())
      throw new Error('Storage quiet period is active');
    const storage = await this.media.reclamationStorage(signal);
    if (
      storage.peerId !== authority.storage.peerId ||
      storage.nodeEpoch === authority.storage.epoch ||
      storage.serverTimeUnixMs < Date.parse(authority.quietUntil)
    )
      throw new Error(
        'A healthy restarted process on the original node is required',
      );
    if (kind === 'unpin')
      await this.reclamation.verifyRecovery(operation, signal);
    const cid = 'cid' in authority ? authority.cid : authority.inputCid;
    const pinned = await this.media.pinned(cid, signal);
    const after = await this.media.reclamationStorage(signal);
    if (
      after.peerId !== storage.peerId ||
      after.nodeEpoch !== storage.nodeEpoch
    )
      throw new Error('Storage changed during recovery verification');
    signal.throwIfAborted();
    return this.recoveries.commit(kind, operation, after, pinned);
  }
  async onModuleDestroy() {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending]);
  }
}
