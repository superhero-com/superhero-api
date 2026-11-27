import {
  ConflictException,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ShortsService } from './shorts.service';
import { ShortsMediaService } from './shorts-media.service';
import { ShortsDeliverySelectionService } from './shorts-delivery-selection.service';
import {
  ShortsInputReclamationReservationsService,
  InputReclamationReservation,
} from './shorts-input-reclamation-reservations.service';
import { ShortsInputReclamationPermitsService } from './shorts-input-reclamation-permits.service';
import { ShortsReclamationReleaseService } from './shorts-reclamation-release.service';
import { shortsStorageScope } from './shorts-runtime-scope';

/** Explicit, default-off lifecycle operation. No creator route, timer, private deletion or GC. */
@Injectable()
export class ShortsInputReclamationService implements OnModuleDestroy {
  private readonly enabled: boolean;
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly shorts: ShortsService,
    private readonly media: ShortsMediaService,
    private readonly selections: ShortsDeliverySelectionService,
    private readonly reservations: ShortsInputReclamationReservationsService,
    private readonly permits: ShortsInputReclamationPermitsService,
    private readonly releases: ShortsReclamationReleaseService,
  ) {
    const flag =
      process.env.SHORTS_DELIVERY_INPUT_RECLAMATION_ENABLED ?? 'false';
    if (!['true', 'false'].includes(flag))
      throw new Error('Invalid input reclamation flag');
    this.enabled = flag === 'true';
    if (this.enabled && process.env.SHORTS_IPFS_EXPIRING_WRITES !== 'true')
      throw new Error('Input reclamation requires expiring storage writers');
  }
  private async bounded<T>(
    parent: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    if (this.shutdown.signal.aborted || this.pending.size >= 2)
      throw new ServiceUnavailableException('Input reclamation unavailable');
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(600000),
      ...(parent ? [parent] : []),
    ]);
    signal.throwIfAborted();
    const task = work(signal);
    this.pending.add(task);
    try {
      return await task;
    } finally {
      this.pending.delete(task);
    }
  }
  private async verifyRoots(
    reservation: InputReclamationReservation,
    signal: AbortSignal,
    recovering = false,
  ) {
    const scope = shortsStorageScope(this.shorts.chain);
    for (const root of reservation.roots) {
      signal.throwIfAborted();
      // This process cannot attest chain policy for a different deployment.
      if (root.network !== scope.network || root.contract !== scope.contract)
        throw new Error(
          'Every reclamation root needs its configured deployment authority',
        );
      const original = await this.shorts.ensurePlayable(root.shortId);
      const target = await this.selections.acknowledged(
        scope,
        original,
        root.sourceKey,
      );
      if (
        target.record.id !== root.jobId ||
        target.record.derivatives?.cid !== reservation.inputCid
      )
        throw new Error('Input reclamation root changed');
      await this.media.verifyDurableDelivery(
        target.record,
        target.descriptor,
        target.prepared,
        signal,
      );
      await this.shorts.ensurePlayable(root.shortId);
    }
    signal.throwIfAborted();
    if (
      JSON.stringify(scope) !==
      JSON.stringify(shortsStorageScope(this.shorts.chain))
    )
      throw new Error('Reclamation deployment changed');
    await this.reservations.verify(reservation.operationId, recovering);
  }
  /** Recovery re-verifies retained bytes but grants no new mutation authority. */
  async verifyRecovery(operation: string, signal: AbortSignal) {
    const permit = await this.permits.get(operation);
    const reservation =
      permit && (await this.reservations.get(permit.reservationId));
    if (!reservation) throw new Error('Input reclamation reservation missing');
    await this.verifyRoots(reservation, signal, true);
  }
  async reclaim(cid: string, operation: string, parent?: AbortSignal) {
    return this.bounded(parent, async (signal) => {
      if (!this.enabled)
        throw new ServiceUnavailableException('Input reclamation is disabled');
      // Replays report the existing operation; they never send a second mutation.
      const saved = await this.reservations.get(operation);
      if (saved && saved.inputCid !== cid)
        throw new ConflictException('Reclamation operation was already used');
      const old = await this.permits.get(operation);
      if (old) return { reservation: saved, permit: old };
      const reservation = await this.reservations.reserve(cid, operation);
      try {
        await this.verifyRoots(reservation, signal);
        const storage = await this.media.reclamationStorage(signal);
        signal.throwIfAborted();
        const issued = await this.permits.issueForDispatch(
          operation,
          operation,
        );
        if (!issued.created) return { reservation, permit: issued.permit };
        let sent = false;
        try {
          if (Math.abs(Date.parse(issued.permit.issuedAt) - Date.now()) > 5000)
            throw new Error('Database clock synchronization unavailable');
          const bound = await this.permits.bind(operation, {
            peerId: storage.peerId,
            epoch: storage.nodeEpoch,
          });
          await this.reservations.verify(operation);
          signal.throwIfAborted();
          sent = true;
          const outcome = await this.media.reclaimInputPin(bound, signal);
          const permit = await this.permits.finish(operation, outcome);
          return {
            reservation: await this.reservations.get(operation),
            permit,
          };
        } catch (error) {
          // Preserve uncertain authority even after expiry, restart or lost SQL acknowledgement.
          await this.permits
            .finish(operation, sent ? 'uncertain' : 'rejected')
            .catch(() => {});
          throw error;
        }
      } catch (error) {
        // The SQL guard retains issued/unknown permits. Only unused reservations can disappear.
        if (!(await this.permits.get(operation)))
          await this.reservations.cancel(operation);
        throw error;
      }
    });
  }
  /** Finish a known outcome after its full quiet window; never resolve an unknown operation here. */
  async release(operation: string, parent?: AbortSignal) {
    return this.bounded(parent, async (signal) => {
      const permit = await this.permits.get(operation);
      if (
        !permit ||
        !permit.storage ||
        !['removed', 'not-pinned', 'rejected'].includes(permit.state)
      )
        throw new Error('A known bound storage outcome is required');
      const saved = await this.releases.get(operation);
      if (saved) return saved;
      if (Date.parse(permit.quietUntil) > Date.now())
        throw new Error('Input reclamation quiet period is active');
      const storage = await this.media.reclamationStorage(signal);
      if (
        storage.peerId !== permit.storage.peerId ||
        storage.nodeEpoch !== permit.storage.epoch ||
        storage.serverTimeUnixMs < Date.parse(permit.quietUntil)
      )
        throw new Error('Storage recovery is required');
      const pinned = await this.media.pinned(permit.inputCid, signal);
      const after = await this.media.reclamationStorage(signal);
      if (
        after.peerId !== storage.peerId ||
        after.nodeEpoch !== storage.nodeEpoch
      )
        throw new Error('Storage changed during release verification');
      signal.throwIfAborted();
      return this.releases.commit(operation, after, pinned);
    });
  }
  async onModuleDestroy() {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending]);
  }
}
