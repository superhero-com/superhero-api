import { firstHTag, RelaySubscriberService } from '../relay-subscriber.service';
import { shardForGroupId } from '../shard';

/**
 * Unit coverage for the relay subscriber's ROUTER + dedup + coalescing + fan-out +
 * rate-cap + circuit-breaker (Task 14, plan §7.1). No real socket: we drive
 * `onEvent` directly and assert the resulting enqueues over mocked repos/queue/redis.
 *
 * A valid relay-admin nsec is required only so the constructor can decode it; the
 * connection lifecycle is never invoked here (no `onModuleInit`).
 */
const RELAY_ADMIN_NSEC =
  'nsec1dwg3l5mumawgr4xq4kc6klagytkj2w4s4kd2rrthy47g3v5mwx8qwrh7sx';

const GID = 'ct_room_sale';
const SYMBOL = 'ROOM';

type Mock = jest.Mock;

interface Harness {
  svc: RelaySubscriberService;
  add: Mock;
  getJobCounts: Mock;
  isRoomEnabled: Mock;
  incrementWithCap: Mock;
  recordSeen: Mock;
  findRoom: Mock;
  findMembers: Mock;
}

function makeHarness(
  config: Partial<{
    msgCoalesceWindowSec: number;
    msgRateCap: number;
    roomNotifyDepthBreak: number;
    subscriberShards: number;
    communityTokenRefreshSec: number;
    relayHealthPauseSec: number;
  }> = {},
): Harness {
  const add: Mock = jest.fn().mockResolvedValue({ id: 'job1' });
  const getJobCounts: Mock = jest
    .fn()
    .mockResolvedValue({ waiting: 0, delayed: 0 });
  const isRoomEnabled: Mock = jest.fn().mockResolvedValue(true);
  const incrementWithCap: Mock = jest
    .fn()
    .mockResolvedValue({ count: 1, capped: false });

  // room_message_seen INSERT ... ON CONFLICT DO NOTHING → returns inserted ids.
  const recordSeen: Mock = jest.fn().mockResolvedValue({
    identifiers: [{ event_id: 'e1' }],
    raw: [{ event_id: 'e1' }],
  });
  const insertChain = {
    insert: () => insertChain,
    into: () => insertChain,
    values: () => insertChain,
    orIgnore: () => insertChain,
    returning: () => insertChain,
    execute: () => recordSeen(),
  };

  const findRoom: Mock = jest.fn().mockResolvedValue({
    sale_address: GID,
    symbol: SYMBOL,
    deleted: false,
  });
  const findMembers: Mock = jest.fn().mockResolvedValue([
    { member_address: 'ak_alice', member_pubkey: 'pk_alice' },
    { member_address: 'ak_bob', member_pubkey: 'pk_bob' },
  ]);

  const tokenRepo = { find: jest.fn().mockResolvedValue([]) } as any;
  const roomRepo = { findOne: findRoom } as any;
  const membershipRepo = { find: findMembers } as any;
  const seenRepo = {
    createQueryBuilder: () => insertChain,
  } as any;
  const roomPreferences = { isRoomEnabled } as any;
  const redis = { incrementWithCap } as any;
  const notifyQueue = { add, getJobCounts } as any;
  const cfg = {
    nostrBotNsec: RELAY_ADMIN_NSEC,
    nostrRelayUrl: 'ws://localhost:7777',
    msgCoalesceWindowSec: config.msgCoalesceWindowSec ?? 0,
    msgRateCap: config.msgRateCap ?? 0,
    roomNotifyDepthBreak: config.roomNotifyDepthBreak ?? 10000,
    subscriberShards: config.subscriberShards ?? 1,
    communityTokenRefreshSec: config.communityTokenRefreshSec ?? 300,
    relayHealthPauseSec: config.relayHealthPauseSec ?? 5,
  } as any;

  const svc = new RelaySubscriberService(
    tokenRepo,
    roomRepo,
    membershipRepo,
    seenRepo,
    roomPreferences,
    redis,
    notifyQueue,
    cfg,
  );

  return {
    svc,
    add,
    getJobCounts,
    isRoomEnabled,
    incrementWithCap,
    recordSeen,
    findRoom,
    findMembers,
  };
}

function chatEvent(
  over: Partial<{
    id: string;
    pubkey: string;
    kind: number;
    tags: string[][];
  }> = {},
): any {
  return {
    id: over.id ?? 'e1',
    pubkey: over.pubkey ?? 'pk_sender',
    kind: over.kind ?? 9,
    created_at: 1700000000,
    content: 'hi',
    tags: over.tags ?? [['h', GID]],
    sig: 'x',
  };
}

describe('firstHTag', () => {
  it('returns the first h-tag value', () => {
    expect(firstHTag({ tags: [['h', GID]] })).toBe(GID);
  });
  it('first h-tag wins when multiple', () => {
    expect(
      firstHTag({
        tags: [
          ['h', 'ct_a'],
          ['h', 'ct_b'],
        ],
      }),
    ).toBe('ct_a');
  });
  it('ignores non-h tags before the h-tag', () => {
    expect(
      firstHTag({
        tags: [
          ['e', 'x'],
          ['h', GID],
        ],
      }),
    ).toBe(GID);
  });
  it('undefined when no h-tag', () => {
    expect(firstHTag({ tags: [['e', 'x']] })).toBeUndefined();
    expect(firstHTag({ tags: [] })).toBeUndefined();
    expect(firstHTag({})).toBeUndefined();
  });
  it('undefined when h-tag has empty value', () => {
    expect(firstHTag({ tags: [['h', '']] })).toBeUndefined();
  });
});

describe('RelaySubscriberService.onEvent (window=0, immediate flush)', () => {
  it('h-routing: enqueues one job per added member except the author', async () => {
    const h = makeHarness();
    // Author is bob (member_pubkey pk_bob); alice should get a job, bob excluded.
    await h.svc.onEvent(chatEvent({ pubkey: 'pk_bob' }));
    expect(h.add).toHaveBeenCalledTimes(1);
    const [name, payload] = h.add.mock.calls[0];
    expect(name).toBe('room-message');
    expect(payload).toMatchObject({
      sale_address: GID,
      recipient: 'ak_alice',
      symbol: SYMBOL,
      message_count: 1,
      sample_event_id: 'e1',
    });
  });

  it('fan-out to all members when the author is not a member', async () => {
    const h = makeHarness();
    await h.svc.onEvent(chatEvent({ pubkey: 'pk_outsider' }));
    expect(h.add).toHaveBeenCalledTimes(2);
    const recipients = h.add.mock.calls.map((c) => c[1].recipient).sort();
    expect(recipients).toEqual(['ak_alice', 'ak_bob']);
  });

  it('missing h-tag → dropped (no dedup, no fan-out)', async () => {
    const h = makeHarness();
    await h.svc.onEvent(chatEvent({ tags: [['e', 'x']] }));
    expect(h.recordSeen).not.toHaveBeenCalled();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('unknown room → dropped after dedup record', async () => {
    const h = makeHarness();
    h.findRoom.mockResolvedValueOnce(null);
    await h.svc.onEvent(chatEvent());
    expect(h.recordSeen).toHaveBeenCalledTimes(1); // still deduped
    expect(h.add).not.toHaveBeenCalled();
  });

  it('deleted room → dropped after dedup record', async () => {
    const h = makeHarness();
    h.findRoom.mockResolvedValueOnce({
      sale_address: GID,
      symbol: SYMBOL,
      deleted: true,
    });
    await h.svc.onEvent(chatEvent());
    expect(h.recordSeen).toHaveBeenCalledTimes(1);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('dedup: a re-delivered event.id is skipped (no fan-out)', async () => {
    const h = makeHarness();
    // First sight inserts; second sight: orIgnore returns no identifiers.
    h.recordSeen
      .mockResolvedValueOnce({ identifiers: [{ event_id: 'e1' }], raw: [{}] })
      .mockResolvedValueOnce({ identifiers: [], raw: [] });

    await h.svc.onEvent(chatEvent({ pubkey: 'pk_outsider' }));
    expect(h.add).toHaveBeenCalledTimes(2);
    h.add.mockClear();

    await h.svc.onEvent(chatEvent({ pubkey: 'pk_outsider' }));
    expect(h.findRoom).toHaveBeenCalledTimes(1); // not re-resolved
    expect(h.add).not.toHaveBeenCalled();
  });

  it('mute: per-room/type-level muted recipient is excluded', async () => {
    const h = makeHarness();
    // alice enabled, bob muted.
    h.isRoomEnabled.mockImplementation(
      async (addr: string) => addr === 'ak_alice',
    );
    await h.svc.onEvent(chatEvent({ pubkey: 'pk_outsider' }));
    const recipients = h.add.mock.calls.map((c) => c[1].recipient);
    expect(recipients).toEqual(['ak_alice']);
  });

  it('only relay_state=added members are queried as recipients', async () => {
    const h = makeHarness();
    await h.svc.onEvent(chatEvent({ pubkey: 'pk_outsider' }));
    expect(h.findMembers).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sale_address: GID, relay_state: 'added' },
      }),
    );
  });

  it('rate cap: a recipient over the cap is dropped (and counted via redis)', async () => {
    const h = makeHarness({ msgRateCap: 1 });
    // alice under cap, bob over cap.
    h.incrementWithCap.mockImplementation(async (key: string) => ({
      count: key.includes('ak_bob') ? 2 : 1,
      capped: key.includes('ak_bob'),
    }));
    await h.svc.onEvent(chatEvent({ pubkey: 'pk_outsider' }));
    const recipients = h.add.mock.calls.map((c) => c[1].recipient);
    expect(recipients).toEqual(['ak_alice']);
    expect(h.incrementWithCap).toHaveBeenCalledTimes(2);
  });

  it('circuit breaker: depth over threshold pauses enqueue but still dedups', async () => {
    const h = makeHarness({ roomNotifyDepthBreak: 10 });
    h.getJobCounts.mockResolvedValue({ waiting: 20, delayed: 0 });
    await h.svc.onEvent(chatEvent({ pubkey: 'pk_outsider' }));
    expect(h.recordSeen).toHaveBeenCalledTimes(1); // dedup recorded while paused
    expect(h.add).not.toHaveBeenCalled();
  });

  it('circuit breaker resumes once depth drops below the low-water mark', async () => {
    const h = makeHarness({ roomNotifyDepthBreak: 10 });
    // Trip: depth 20 ≥ 10.
    h.getJobCounts.mockResolvedValueOnce({ waiting: 20, delayed: 0 });
    await h.svc.onEvent(chatEvent({ id: 'e1', pubkey: 'pk_outsider' }));
    expect(h.add).not.toHaveBeenCalled();

    // Resume: depth 4 ≤ 5 (half of 10).
    h.getJobCounts.mockResolvedValue({ waiting: 4, delayed: 0 });
    await h.svc.onEvent(chatEvent({ id: 'e2', pubkey: 'pk_outsider' }));
    expect(h.add).toHaveBeenCalledTimes(2);
  });
});

describe('RelaySubscriberService coalescing (window>0)', () => {
  // Real timers with a tiny window — the flush is async (DB + queue), which fake
  // timers + microtask flushing make brittle; a short real window is deterministic.
  const WINDOW_MS = 1;
  const waitForFlush = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, WINDOW_MS + 25));
  };

  it('5 messages in one room within the window → one job per recipient, count=5', async () => {
    const h = makeHarness({ msgCoalesceWindowSec: WINDOW_MS / 1000 });
    // Open the window, then immediately bump it before the (tiny) timer fires.
    await h.svc.onEvent(chatEvent({ id: 'e0', pubkey: 'pk_outsider' }));
    // Reach into the buffer to add 4 more without racing the timer.
    const entry = (h.svc as any).coalescing.get(GID);
    entry.count = 5;
    expect(h.add).not.toHaveBeenCalled();

    await waitForFlush();

    // 2 added members (alice + bob), one job each, message_count = 5.
    expect(h.add).toHaveBeenCalledTimes(2);
    for (const call of h.add.mock.calls) {
      expect(call[1].message_count).toBe(5);
    }
  });

  it('a single message in the window flushes with count=1', async () => {
    const h = makeHarness({ msgCoalesceWindowSec: WINDOW_MS / 1000 });
    await h.svc.onEvent(chatEvent({ id: 'solo', pubkey: 'pk_outsider' }));
    await waitForFlush();
    expect(h.add).toHaveBeenCalledTimes(2);
    expect(h.add.mock.calls[0][1].message_count).toBe(1);
  });

  it('dedup holds across the window (same id within window counted once)', async () => {
    const h = makeHarness({ msgCoalesceWindowSec: WINDOW_MS / 1000 });
    h.recordSeen
      .mockResolvedValueOnce({ identifiers: [{}], raw: [{}] })
      .mockResolvedValue({ identifiers: [], raw: [] });
    await h.svc.onEvent(chatEvent({ id: 'dup', pubkey: 'pk_outsider' }));
    await h.svc.onEvent(chatEvent({ id: 'dup', pubkey: 'pk_outsider' }));
    await waitForFlush();
    // Only the first sight counted → count=1.
    expect(h.add).toHaveBeenCalledTimes(2);
    expect(h.add.mock.calls[0][1].message_count).toBe(1);
  });
});

describe('RelaySubscriberService sharding (onEvent)', () => {
  it('drops events for groups outside this shard', async () => {
    const h = makeHarness({ subscriberShards: 4 });
    // Find a gid that does NOT belong to shard 0.
    let foreignGid = '';
    for (let i = 0; i < 1000; i++) {
      const g = `ct_foreign_${i}`;
      if (shardForGroupId(g, 4) !== 0) {
        foreignGid = g;
        break;
      }
    }
    expect(foreignGid).not.toBe('');
    await h.svc.onEvent(chatEvent({ tags: [['h', foreignGid]] }));
    expect(h.recordSeen).not.toHaveBeenCalled();
    expect(h.add).not.toHaveBeenCalled();
  });
});
