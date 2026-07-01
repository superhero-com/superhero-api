import type { Queue } from 'bull';
import {
  ACCESS_REVOKE_FINALIZE_JOB,
  RECONCILE_MEMBERSHIP_JOB,
  RECONCILE_MEMBERSHIP_QUEUE,
  REORG_FLUSH_JOB,
  ReconcileProcessor,
} from '../reconcile.processor';

/**
 * Unit coverage for the `worker:reconcile-membership` consumer (Task 11): the two
 * `@Process` handlers delegate to the services, and boot scheduling + the handlers
 * are relay-gated — they run iff a relay is configured (`isRelayConfigured` on the
 * injected `tgrConfig`: `nostrRelayUrl` + `nostrBotNsec` both set). Worker mode is
 * gone (see `deworker-plan.md`); with no relay configured the processor still
 * instantiates (boot-safe) but schedules/runs nothing.
 */
describe('ReconcileProcessor (unit)', () => {
  /**
   * @param relayConfigured when true, the injected config carries
   *   `nostrRelayUrl` + `nostrBotNsec` (relay enabled → jobs scheduled / handlers
   *   active). When false those are unset (relay dormant → no scheduling / no-op
   *   handlers).
   */
  const build = (relayConfigured: boolean) => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'j' }) };
    const reconciliation = {
      reconcileBatch: jest.fn().mockResolvedValue({
        roomsScanned: 1,
        added: 0,
        removed: 0,
        nextCursor: null,
      }),
    };
    const reorgEviction = {
      flushDueEvictions: jest
        .fn()
        .mockResolvedValue({ published: 0, cancelled: 0 }),
    };
    const membershipAccess = {
      finalizeDueRevokes: jest
        .fn()
        .mockResolvedValue({ revoked: 0, cancelled: 0 }),
    };
    const config = {
      reconcileIntervalSec: 600,
      nostrRelayUrl: relayConfigured ? 'ws://relay' : undefined,
      nostrBotNsec: relayConfigured ? 'nsec1abc' : undefined,
    };
    const processor = new ReconcileProcessor(
      queue as unknown as Queue,
      reconciliation as any,
      reorgEviction as any,
      membershipAccess as any,
      config as any,
    );
    return { processor, queue, reconciliation, reorgEviction, membershipAccess };
  };

  it('exposes the canonical worker-prefixed queue name', () => {
    expect(RECONCILE_MEMBERSHIP_QUEUE).toBe('worker:reconcile-membership');
  });

  describe('onModuleInit', () => {
    it('schedules the relay jobs + the finalizer when a relay is configured', async () => {
      const { processor, queue } = build(true);

      await processor.onModuleInit();

      const jobNames = queue.add.mock.calls.map((c) => c[0]);
      expect(jobNames).toEqual(
        expect.arrayContaining([
          RECONCILE_MEMBERSHIP_JOB,
          REORG_FLUSH_JOB,
          ACCESS_REVOKE_FINALIZE_JOB,
        ]),
      );
      expect(queue.add).toHaveBeenCalledTimes(3);
      // The two relay jobs repeat on the configured interval (10m → 600s).
      for (const call of queue.add.mock.calls) {
        if (call[0] === ACCESS_REVOKE_FINALIZE_JOB) {
          // The finalizer runs more often: min(30s, interval).
          expect(call[2].repeat).toEqual({ every: 30_000 });
        } else {
          expect(call[2].repeat).toEqual({ every: 600_000 });
        }
      }
    });

    it('still schedules the relay-independent finalizer when no relay is configured', async () => {
      const { processor, queue } = build(false);

      await processor.onModuleInit();

      // Only the finalizer (pure DB + event-emit) — no relay read/publish jobs.
      const jobNames = queue.add.mock.calls.map((c) => c[0]);
      expect(jobNames).toEqual([ACCESS_REVOKE_FINALIZE_JOB]);
      expect(queue.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('handlers (relay-gated)', () => {
    it('reconcile() delegates to reconcileBatch when a relay is configured', async () => {
      const { processor, reconciliation } = build(true);

      await processor.reconcile();

      expect(reconciliation.reconcileBatch).toHaveBeenCalledTimes(1);
    });

    it('flush() delegates to flushDueEvictions when a relay is configured', async () => {
      const { processor, reorgEviction } = build(true);

      await processor.flush();

      expect(reorgEviction.flushDueEvictions).toHaveBeenCalledTimes(1);
    });

    it('reconcile()/flush() are no-ops when no relay is configured', async () => {
      const { processor, reconciliation, reorgEviction } = build(false);

      await processor.reconcile();
      await processor.flush();

      expect(reconciliation.reconcileBatch).not.toHaveBeenCalled();
      expect(reorgEviction.flushDueEvictions).not.toHaveBeenCalled();
    });

    it('finalizeRevokes() delegates regardless of relay config', async () => {
      for (const relay of [true, false]) {
        const { processor, membershipAccess } = build(relay);
        await processor.finalizeRevokes();
        expect(membershipAccess.finalizeDueRevokes).toHaveBeenCalledTimes(1);
      }
    });
  });
});
