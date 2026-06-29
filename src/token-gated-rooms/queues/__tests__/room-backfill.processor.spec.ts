import type { Job, Queue } from 'bull';
import { RoomBackfillProcessor } from '../room-backfill.processor';
import type { BackfillKickoffJob } from '../room-backfill.processor';
import {
  BACKFILL_KICKOFF_JOB,
  BACKFILL_STALE_SWEEP_JOB,
} from '../room-backfill.constants';

/**
 * Unit coverage for the `worker:room-backfill` consumer (Task 09): the kickoff
 * delegates to the service's `processPage`, chains the next page (keyset cursor)
 * only while `hasMore`, and the stale sweep delegates to `sweepStalePending`.
 */
describe('RoomBackfillProcessor (unit)', () => {
  const makeJob = (data: BackfillKickoffJob): Job<BackfillKickoffJob> =>
    ({ data }) as any;

  const build = (
    processPage: jest.Mock,
    sweepStalePending: jest.Mock = jest.fn().mockResolvedValue(0),
    backfillPageDelayMs = 1000,
  ) => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'j' }) } as any;
    const backfill = { processPage, sweepStalePending } as any;
    const processor = new RoomBackfillProcessor(
      backfill,
      queue as unknown as Queue,
      { backfillPageDelayMs } as any,
    );
    return { processor, queue, backfill };
  };

  it('first page (no cursor) → calls processPage(undefined) and chains by nextCursor while hasMore', async () => {
    const processPage = jest.fn().mockResolvedValue({
      requested: 2,
      nextCursor: 'ct_b',
      hasMore: true,
    });
    const { processor, queue } = build(processPage);

    await processor.kickoff(makeJob({}));

    expect(processPage).toHaveBeenCalledWith(undefined);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      BACKFILL_KICKOFF_JOB,
      { afterSaleAddress: 'ct_b' },
      expect.objectContaining({ removeOnComplete: true, delay: 1000 }),
    );
  });

  it('paces the chained page with the configured backfillPageDelayMs', async () => {
    const processPage = jest.fn().mockResolvedValue({
      requested: 1,
      nextCursor: 'ct_c',
      hasMore: true,
    });
    const { processor, queue } = build(processPage, undefined, 250);

    await processor.kickoff(makeJob({}));

    expect(queue.add).toHaveBeenCalledWith(
      BACKFILL_KICKOFF_JOB,
      { afterSaleAddress: 'ct_c' },
      expect.objectContaining({ delay: 250 }),
    );
  });

  it('passes the supplied keyset cursor through to processPage', async () => {
    const processPage = jest.fn().mockResolvedValue({
      requested: 0,
      nextCursor: undefined,
      hasMore: false,
    });
    const { processor } = build(processPage);

    await processor.kickoff(makeJob({ afterSaleAddress: 'ct_m' }));

    expect(processPage).toHaveBeenCalledWith('ct_m');
  });

  it('does NOT chain when the working set is drained (!hasMore)', async () => {
    const processPage = jest.fn().mockResolvedValue({
      requested: 1,
      nextCursor: 'ct_z',
      hasMore: false,
    });
    const { processor, queue } = build(processPage);

    await processor.kickoff(makeJob({}));

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does NOT chain when hasMore but no cursor (defensive guard)', async () => {
    const processPage = jest.fn().mockResolvedValue({
      requested: 0,
      nextCursor: undefined,
      hasMore: true,
    });
    const { processor, queue } = build(processPage);

    await processor.kickoff(makeJob({}));

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('stale sweep delegates to sweepStalePending', async () => {
    const sweep = jest.fn().mockResolvedValue(3);
    const { processor, backfill } = build(jest.fn(), sweep);

    await processor.staleSweep();

    expect(backfill.sweepStalePending).toHaveBeenCalledTimes(1);
  });

  it('exposes the canonical job names', () => {
    expect(BACKFILL_KICKOFF_JOB).toBe('backfill-kickoff');
    expect(BACKFILL_STALE_SWEEP_JOB).toBe('backfill-stale-sweep');
  });
});
