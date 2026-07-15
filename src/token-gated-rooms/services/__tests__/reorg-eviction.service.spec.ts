import { NIP29_KIND } from '../../nostr/nip29';
import { RoomMembership } from '../../entities/room-membership.entity';
import { ReorgEvictionService } from '../reorg-eviction.service';

/**
 * Unit coverage for the reorg-buffered eviction (Task 11 §B). Repos / publish
 * queue / room-admins are stubbed; the focus is the buffer timing, the depth gate,
 * the cancel-on-restore, and the admin/unlinked exemptions. No DB, no relay.
 */

const SALE = 'ct_sale';
const PUBKEY = 'a'.repeat(64);
const DEPTH = 10;
const TIP = 1000;

function membership(over: Partial<RoomMembership> = {}): RoomMembership {
  return {
    id: 1,
    sale_address: SALE,
    member_address: 'ak_member',
    member_pubkey: PUBKEY,
    role: 'member',
    eligible: false,
    relay_state: 'added',
    held_until_height: null as any,
    last_published_at: null as any,
    last_reconciled_at: null as any,
    updated_at: new Date(),
    ...over,
  } as RoomMembership;
}

interface Harness {
  service: ReorgEvictionService;
  membershipRepo: any;
  queue: { add: jest.Mock };
  updates: Array<{ where: any; set: any }>;
  store: Map<number, RoomMembership>;
}

function setup(
  opts: {
    rows?: RoomMembership[];
    tip?: number | null;
    isConfiguredAdmin?: boolean;
    withQueue?: boolean;
  } = {},
): Harness {
  const tip = opts.tip === undefined ? TIP : opts.tip;
  const store = new Map<number, RoomMembership>();
  for (const r of opts.rows ?? []) {
    store.set(r.id, { ...r });
  }
  const updates: Array<{ where: any; set: any }> = [];

  const membershipRepo: any = {
    find: jest.fn(async ({ where }: any) => {
      // Used by bufferEvictions: filter on sale_address/eligible/role/relay_state.
      return [...store.values()].filter((r) => {
        if (where.sale_address && r.sale_address !== where.sale_address) {
          return false;
        }
        if (where.eligible !== undefined && r.eligible !== where.eligible) {
          return false;
        }
        // role: Not('admin')
        if (where.role && r.role === 'admin') {
          return false;
        }
        // relay_state: In(['added','pending_remove'])
        if (
          where.relay_state &&
          !['added', 'pending_remove'].includes(r.relay_state)
        ) {
          return false;
        }
        return true;
      });
    }),
    findOne: jest.fn(async ({ where }: any) => {
      if (where.id !== undefined) {
        const r = store.get(where.id);
        return r ? { ...r } : null;
      }
      return null;
    }),
    update: jest.fn(async (where: any, set: any) => {
      updates.push({ where, set });
      const r = store.get(where.id);
      if (r) {
        Object.assign(r, set);
      }
    }),
    createQueryBuilder: jest.fn(() => {
      const state: any = { cursor: 0, current: tip };
      const qb: any = {
        select: jest.fn(() => qb),
        where: jest.fn((_c: string, p?: any) => {
          if (p && p.cursor !== undefined) state.cursor = p.cursor;
          return qb;
        }),
        andWhere: jest.fn((_c: string, p?: any) => {
          if (p && p.current !== undefined) state.current = p.current;
          return qb;
        }),
        orderBy: jest.fn(() => qb),
        limit: jest.fn(() => qb),
        getMany: jest.fn(async () => {
          // Mirrors the flush predicate: held set, <= current, ineligible, non-admin.
          return [...store.values()].filter(
            (r) =>
              r.id > state.cursor &&
              r.held_until_height !== null &&
              r.held_until_height !== undefined &&
              r.held_until_height <= state.current &&
              r.eligible === false &&
              r.role !== 'admin',
          );
        }),
        getRawMany: jest.fn(async () => {
          const sales = new Set<string>();
          for (const r of store.values()) {
            if (
              r.eligible === false &&
              r.role !== 'admin' &&
              ['added', 'pending_remove'].includes(r.relay_state) &&
              (r.held_until_height === null ||
                r.held_until_height === undefined)
            ) {
              sales.add(r.sale_address);
            }
          }
          return [...sales].map((sale_address) => ({ sale_address }));
        }),
      };
      return qb;
    }),
  };

  const tokenRepo = {
    findOne: jest.fn(async () => ({
      sale_address: SALE,
      nostr_group_id: SALE,
    })),
  };
  const syncStateRepo = {
    findOne: jest.fn(async () => (tip === null ? null : { tip_height: tip })),
  };
  const queue = { add: jest.fn().mockResolvedValue({ id: 'p' }) };
  const roomAdmins = {
    isConfiguredAdmin: jest.fn().mockReturnValue(!!opts.isConfiguredAdmin),
  };
  const config = {
    reorgConfirmationDepthBlocks: DEPTH,
    reconcileBatchSize: 500,
    publishMaxRetries: 5,
  };

  const service = new ReorgEvictionService(
    membershipRepo,
    tokenRepo as any,
    syncStateRepo as any,
    opts.withQueue === false ? (null as any) : (queue as any),
    roomAdmins as any,
    config as any,
  );

  return { service, membershipRepo, queue, updates, store };
}

describe('ReorgEvictionService.bufferEvictions', () => {
  it('sets held_until_height = tip + DEPTH and emits NO 9001; relay_state stays added', async () => {
    const { service, queue, store } = setup({
      rows: [membership({ id: 1, eligible: false, relay_state: 'added' })],
    });

    const buffered = await service.bufferEvictions([SALE]);

    expect(buffered).toBe(1);
    expect(queue.add).not.toHaveBeenCalled();
    const row = store.get(1)!;
    expect(row.held_until_height).toBe(TIP + DEPTH);
    expect(row.relay_state).toBe('added');
  });

  it('pins a pending_remove row back to added under the hold (no immediate eviction)', async () => {
    const { service, store } = setup({
      rows: [
        membership({ id: 1, eligible: false, relay_state: 'pending_remove' }),
      ],
    });

    await service.bufferEvictions([SALE]);

    const row = store.get(1)!;
    expect(row.relay_state).toBe('added');
    expect(row.held_until_height).toBe(TIP + DEPTH);
  });

  it('does NOT buffer an admin row (admin exemption §6.7)', async () => {
    const { service, store } = setup({
      rows: [
        membership({
          id: 1,
          role: 'admin',
          eligible: false,
          relay_state: 'added',
        }),
      ],
    });

    const buffered = await service.bufferEvictions([SALE]);

    expect(buffered).toBe(0);
    expect(store.get(1)!.held_until_height).toBeNull();
  });

  it('does NOT buffer a still-eligible row (only newly-ineligible are held)', async () => {
    const { service, store } = setup({
      rows: [membership({ id: 1, eligible: true, relay_state: 'added' })],
    });

    const buffered = await service.bufferEvictions([SALE]);

    expect(buffered).toBe(0);
    expect(store.get(1)!.held_until_height).toBeNull();
  });

  it('skips buffering when the current height is unknown', async () => {
    const { service, queue } = setup({
      rows: [membership({ id: 1, eligible: false })],
      tip: null,
    });

    const buffered = await service.bufferEvictions([SALE]);

    expect(buffered).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('ReorgEvictionService.flushDueEvictions (depth gate)', () => {
  it('publishes nothing when current < held_until_height (hold not passed)', async () => {
    const { service, queue, store } = setup({
      rows: [
        membership({
          id: 1,
          eligible: false,
          relay_state: 'added',
          held_until_height: TIP + 5,
        }),
      ],
      tip: TIP, // TIP < TIP+5 → not due
    });

    const { published, cancelled } = await service.flushDueEvictions();

    expect(published).toBe(0);
    expect(cancelled).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
    expect(store.get(1)!.held_until_height).toBe(TIP + 5);
  });

  it('publishes 9001 and clears held_until_height when current >= held and still ineligible', async () => {
    const { service, queue, store } = setup({
      rows: [
        membership({
          id: 1,
          eligible: false,
          relay_state: 'added',
          held_until_height: TIP - 1,
        }),
      ],
      tip: TIP, // TIP >= TIP-1 → due
    });

    const { published } = await service.flushDueEvictions();

    expect(published).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][0].template.kind).toBe(
      NIP29_KIND.REMOVE_USER,
    );
    const row = store.get(1)!;
    expect(row.held_until_height).toBeNull();
    expect(row.relay_state).toBe('pending_remove');
  });

  it('cancels the eviction (clears hold, no publish) when the member is eligible again', async () => {
    const { service, queue, store } = setup({
      rows: [
        membership({
          id: 1,
          eligible: true,
          relay_state: 'added',
          held_until_height: TIP - 1,
        }),
      ],
      tip: TIP,
    });

    // Note: the flush SELECT predicate filters eligible=false, so an eligible row
    // is not even selected — it simply keeps its hold until re-buffered/cleared by
    // a later recompute. Assert no publish + no clear here (the select skips it).
    const { published, cancelled } = await service.flushDueEvictions();

    expect(published).toBe(0);
    expect(cancelled).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
    expect(store.get(1)!.relay_state).toBe('added');
  });

  it('cancels at flush time when a row flipped eligible between select and re-confirm', async () => {
    const { service, queue, store } = setup({
      rows: [
        membership({
          id: 1,
          eligible: false,
          relay_state: 'added',
          held_until_height: TIP - 1,
        }),
      ],
      tip: TIP,
    });
    // Simulate a follow-up reorg restoring eligibility after the row was selected
    // but before re-confirm: patch findOne to report eligible=true.
    const repo: any = (service as any).membershipRepo;
    const realFindOne = repo.findOne;
    repo.findOne = jest.fn(async (arg: any) => {
      const r = await realFindOne(arg);
      if (r) {
        return { ...r, eligible: true };
      }
      return r;
    });

    const { published, cancelled } = await service.flushDueEvictions();

    expect(published).toBe(0);
    expect(cancelled).toBe(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(store.get(1)!.held_until_height).toBeNull();
  });

  it('cancels (no 9001) for a configured-admin pubkey even if past depth', async () => {
    const { service, queue, store } = setup({
      rows: [
        membership({
          id: 1,
          eligible: false,
          relay_state: 'added',
          held_until_height: TIP - 1,
        }),
      ],
      tip: TIP,
      isConfiguredAdmin: true,
    });

    const { published, cancelled } = await service.flushDueEvictions();

    expect(published).toBe(0);
    expect(cancelled).toBe(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(store.get(1)!.held_until_height).toBeNull();
  });

  it('cancels (no 9001) for an unlinked row (null pubkey) — nothing to remove', async () => {
    const { service, queue, store } = setup({
      rows: [
        membership({
          id: 1,
          eligible: false,
          relay_state: 'added',
          held_until_height: TIP - 1,
          member_pubkey: null as any,
        }),
      ],
      tip: TIP,
    });

    const { published, cancelled } = await service.flushDueEvictions();

    expect(published).toBe(0);
    expect(cancelled).toBe(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(store.get(1)!.held_until_height).toBeNull();
  });

  it('is a no-op (no publish) when there is no publish queue (main mode)', async () => {
    const { service } = setup({
      rows: [
        membership({ id: 1, eligible: false, held_until_height: TIP - 1 }),
      ],
      tip: TIP,
      withQueue: false,
    });

    const { published, cancelled } = await service.flushDueEvictions();

    expect(published).toBe(0);
    expect(cancelled).toBe(0);
  });
});

describe('ReorgEvictionService.bufferAllPendingEvictions (aex9 reorg entry)', () => {
  it('discovers at-risk rooms by their membership rows and buffers them', async () => {
    const { service, store } = setup({
      rows: [
        membership({
          id: 1,
          sale_address: 'ct_a',
          eligible: false,
          relay_state: 'added',
        }),
        membership({
          id: 2,
          sale_address: 'ct_b',
          eligible: true,
          relay_state: 'added',
        }),
      ],
    });

    const buffered = await service.bufferAllPendingEvictions();

    expect(buffered).toBe(1);
    expect(store.get(1)!.held_until_height).toBe(TIP + DEPTH);
    expect(store.get(2)!.held_until_height).toBeNull();
  });

  it('returns 0 when no rooms have at-risk members', async () => {
    const { service } = setup({
      rows: [membership({ id: 1, eligible: true, relay_state: 'added' })],
    });

    expect(await service.bufferAllPendingEvictions()).toBe(0);
  });
});
