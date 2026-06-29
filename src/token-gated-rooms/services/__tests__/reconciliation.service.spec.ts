import { NIP29_KIND } from '../../nostr/nip29';
import { RoomMembership } from '../../entities/room-membership.entity';
import { Token } from '@/tokens/entities/token.entity';
import { ReconciliationService } from '../reconciliation.service';

/**
 * Unit coverage for the rotating read-back reconciliation (Task 11 §A). Repos /
 * relay writer / publish queue / room-admins are stubbed; the focus is the diff
 * logic, the unlinked + admin exemptions, the reorg-hold skip, idempotency (no
 * spurious writes), and the SLA-coverage math. No DB, no relay.
 */

const SALE = 'ct_sale';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function membership(over: Partial<RoomMembership> = {}): RoomMembership {
  return {
    id: 1,
    sale_address: SALE,
    member_address: 'ak_member',
    member_pubkey: A,
    role: 'member',
    eligible: true,
    relay_state: 'added',
    held_until_height: null as any,
    last_published_at: null as any,
    last_reconciled_at: null as any,
    updated_at: new Date(),
    ...over,
  } as RoomMembership;
}

function token(over: Partial<Token> = {}): Token {
  return {
    sale_address: SALE,
    nostr_group_id: SALE,
    nostr_room_state: 'created',
    ...over,
  } as unknown as Token;
}

interface Harness {
  service: ReconciliationService;
  queue: { add: jest.Mock };
  relayMembers: Set<string>;
  convergeRoomAdmins: jest.Mock;
  markReconciledFor: string[];
}

function setup(opts: {
  rows: RoomMembership[];
  relayMembers?: string[];
  tip?: number | null;
  isConfiguredAdmin?: (pubkey: string) => boolean;
  isHealthy?: boolean;
  rooms?: Token[];
}): Harness {
  const relayMembers = new Set(opts.relayMembers ?? []);
  const markReconciledFor: string[] = [];

  const membershipRepo: any = {
    find: jest.fn(async ({ where }: any) => {
      return opts.rows.filter(
        (r) => !where?.sale_address || r.sale_address === where.sale_address,
      );
    }),
    update: jest.fn(async (where: any) => {
      if (where.sale_address) {
        markReconciledFor.push(where.sale_address);
      }
    }),
    createQueryBuilder: jest.fn(() => {
      throw new Error('reconcile unit tests should not hit maxStalenessMs qb');
    }),
  };

  const tokenRepo: any = {
    createQueryBuilder: jest.fn(() => {
      const qb: any = {
        where: jest.fn(() => qb),
        andWhere: jest.fn(() => qb),
        orderBy: jest.fn(() => qb),
        limit: jest.fn(() => qb),
        getMany: jest.fn(async () => opts.rooms ?? []),
      };
      return qb;
    }),
  };

  const syncStateRepo: any = {
    findOne: jest.fn(async () =>
      opts.tip === null || opts.tip === undefined
        ? { tip_height: 0 }
        : { tip_height: opts.tip },
    ),
  };

  const queue = { add: jest.fn().mockResolvedValue({ id: 'p' }) };

  const relay = {
    isHealthy: jest.fn().mockReturnValue(opts.isHealthy ?? true),
    fetchGroupMembers: jest.fn().mockResolvedValue(relayMembers),
  };

  const convergeRoomAdmins = jest.fn().mockResolvedValue(0);
  const roomAdmins = {
    isConfiguredAdmin: jest.fn((pk: string) =>
      opts.isConfiguredAdmin ? opts.isConfiguredAdmin(pk) : false,
    ),
    convergeRoomAdmins,
  };

  const config = {
    reconcileBatchSize: 500,
    reconcileIntervalSec: 600,
    publishMaxRetries: 5,
  };

  const service = new ReconciliationService(
    membershipRepo,
    tokenRepo,
    syncStateRepo,
    queue as any,
    relay as any,
    roomAdmins as any,
    config as any,
  );

  return {
    service,
    queue,
    relayMembers,
    convergeRoomAdmins,
    markReconciledFor,
  };
}

describe('ReconciliationService.reconcileRoom diff', () => {
  it('re-adds (9000) an eligible+linked member missing from 39002', async () => {
    const { service, queue } = setup({
      rows: [membership({ id: 1, member_pubkey: A, eligible: true })],
      relayMembers: [], // 39002 missing A
    });

    const result = await service.reconcileRoom(token());

    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][0].template.kind).toBe(NIP29_KIND.PUT_USER);
  });

  it('re-removes (9001) a present-but-ineligible non-admin member', async () => {
    const { service, queue } = setup({
      rows: [membership({ id: 1, member_pubkey: A, eligible: false })],
      relayMembers: [A], // present on relay but desired-removed
    });

    const result = await service.reconcileRoom(token());

    expect(result.removed).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][0].template.kind).toBe(
      NIP29_KIND.REMOVE_USER,
    );
  });

  it('39002 == desired → NO publishes (idempotent, no spurious writes)', async () => {
    const { service, queue } = setup({
      rows: [membership({ id: 1, member_pubkey: A, eligible: true })],
      relayMembers: [A], // already matches
    });

    const result = await service.reconcileRoom(token());

    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('unlinked invariant: eligible+null-pubkey absent from 39002 is NOT drift-to-add', async () => {
    const { service, queue } = setup({
      rows: [membership({ id: 1, member_pubkey: null as any, eligible: true })],
      relayMembers: [],
    });

    const result = await service.reconcileRoom(token());

    expect(result.added).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('admin exemption: a configured-admin pubkey present in 39002 but ineligible is NOT removed', async () => {
    const { service, queue } = setup({
      rows: [
        membership({
          id: 1,
          member_pubkey: A,
          eligible: false,
          role: 'member',
        }),
      ],
      relayMembers: [A],
      isConfiguredAdmin: (pk) => pk === A,
    });

    const result = await service.reconcileRoom(token());

    expect(result.removed).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('admin exemption: a role=admin row present in 39002 but ineligible is NOT removed', async () => {
    const { service, queue } = setup({
      rows: [
        membership({ id: 1, member_pubkey: A, eligible: false, role: 'admin' }),
      ],
      relayMembers: [A],
    });

    const result = await service.reconcileRoom(token());

    expect(result.removed).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('reorg-hold skip: an unexpired held row still in 39002 is NOT treated as drift-to-remove', async () => {
    const { service, queue } = setup({
      rows: [
        membership({
          id: 1,
          member_pubkey: A,
          eligible: false,
          relay_state: 'added',
          held_until_height: 2000, // > tip → unexpired
        }),
      ],
      relayMembers: [A],
      tip: 1000,
    });

    const result = await service.reconcileRoom(token());

    expect(result.removed).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('expired hold no longer protects: a held row past depth IS drift-to-remove', async () => {
    const { service, queue } = setup({
      rows: [
        membership({
          id: 1,
          member_pubkey: A,
          eligible: false,
          relay_state: 'added',
          held_until_height: 500, // < tip → expired
        }),
      ],
      relayMembers: [A],
      tip: 1000,
    });

    const result = await service.reconcileRoom(token());

    expect(result.removed).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('a relay pubkey with no desired-state row is left alone (not this task drift)', async () => {
    const { service, queue } = setup({
      rows: [],
      relayMembers: [B],
    });

    const result = await service.reconcileRoom(token());

    expect(result.removed).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('stamps last_reconciled_at and runs the admin converge for the room', async () => {
    const { service, convergeRoomAdmins, markReconciledFor } = setup({
      rows: [membership({ id: 1, member_pubkey: A, eligible: true })],
      relayMembers: [A],
    });

    await service.reconcileRoom(token());

    expect(markReconciledFor).toContain(SALE);
    expect(convergeRoomAdmins).toHaveBeenCalledWith(SALE);
  });
});

describe('ReconciliationService.reconcileBatch rotation + health', () => {
  it('skips the run when the relay writer is unhealthy (no read-back, no publish)', async () => {
    const { service, queue } = setup({
      rows: [],
      rooms: [token()],
      isHealthy: false,
    });

    const result = await service.reconcileBatch();

    expect(result.roomsScanned).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('advances + wraps the rotating cursor when the page is shorter than the batch', async () => {
    const { service } = setup({
      rows: [membership({ id: 1, member_pubkey: A, eligible: true })],
      relayMembers: [A],
      rooms: [token({ sale_address: SALE })],
    });

    const result = await service.reconcileBatch();

    expect(result.roomsScanned).toBe(1);
    // Page < batch → cursor wraps to '' for the next rotation.
    expect(service.getCursor()).toBe('');
    expect(result.nextCursor).toBeNull();
  });
});

describe('ReconciliationService SLA coverage math', () => {
  it('default knobs (500 × 144 runs/day) cover ≥ 54,000 rooms/day', () => {
    const { service } = setup({ rows: [] });
    // TG_RECONCILE_BATCH_SIZE=500, TG_RECONCILE_INTERVAL=10m → 144 runs/day → 72,000.
    expect(service.slaCoveragePerDay()).toBe(72000);
    expect(service.slaCoveragePerDay()).toBeGreaterThanOrEqual(54000);
  });
});
