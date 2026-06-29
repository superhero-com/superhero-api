import type { Queue } from 'bull';
import {
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
    const config = {
      reconcileIntervalSec: 600,
      nostrRelayUrl: relayConfigured ? 'ws://relay' : undefined,
      nostrBotNsec: relayConfigured ? 'nsec1abc' : undefined,
    };
    const processor = new ReconcileProcessor(
      queue as unknown as Queue,
      reconciliation as any,
      reorgEviction as any,
      config as any,
    );
    return { processor, queue, reconciliation, reorgEviction };
  };

  it('exposes the canonical worker-prefixed queue name', () => {
    expect(RECONCILE_MEMBERSHIP_QUEUE).toBe('worker:reconcile-membership');
  });

  describe('onModuleInit (relay-gated)', () => {
    it('schedules BOTH repeatable jobs when a relay is configured', async () => {
      const { processor, queue } = build(true);

      await processor.onModuleInit();

      const jobNames = queue.add.mock.calls.map((c) => c[0]);
      expect(jobNames).toEqual(
        expect.arrayContaining([RECONCILE_MEMBERSHIP_JOB, REORG_FLUSH_JOB]),
      );
      expect(queue.add).toHaveBeenCalledTimes(2);
      // Both repeat on the configured interval (10m default → 600s).
      for (const call of queue.add.mock.calls) {
        expect(call[2].repeat).toEqual({ every: 600_000 });
      }
    });

    it('schedules NOTHING when no relay is configured (boot-safe)', async () => {
      const { processor, queue } = build(false);

      await processor.onModuleInit();

      expect(queue.add).not.toHaveBeenCalled();
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
  });
});
