import type { JobOptions, Queue } from 'bull';
import type { RelayWriter } from '../nostr/relay-writer.contract';
import { TGR_CAPPED_BACKOFF } from '../queues/publish-nip29.job-options';
import type { PublishNip29Job } from '../queues/publish-nip29.types';
import {
  NIP29_ROLE_ADMIN,
  NIP29_ROLE_MEMBER,
  RoomAdminsService,
} from './room-admins.service';

/** The (job, opts) tuple the service passes to `queue.add(job, opts)`. */
type AddCall = [PublishNip29Job, JobOptions];

/** Read the n-th `queue.add` call as a typed (job, opts) tuple. */
function addCall(queue: jest.Mocked<Pick<Queue, 'add'>>, n = 0): AddCall {
  return queue.add.mock.calls[n] as unknown as AddCall;
}

/** A deterministic 64-hex pubkey for index `n`. */
const hex = (n: number): string =>
  (n.toString(16).padStart(2, '0') + 'a'.repeat(62)).slice(0, 64);

const BOT = hex(0);
const SALE = 'ct_RoomAdminsSvc1';

function makeConfig(admins: string[]): any {
  return {
    nostrRoomAdmins: admins,
    publishMaxRetries: 5,
  };
}

function makeQueue(): jest.Mocked<Pick<Queue, 'add'>> {
  return { add: jest.fn().mockResolvedValue({ id: 'job1' }) } as any;
}

function makeRelay(
  members: string[] = [],
): jest.Mocked<Pick<RelayWriter, 'pubkey' | 'fetchGroupMembers'>> {
  return {
    pubkey: BOT,
    fetchGroupMembers: jest.fn().mockResolvedValue(new Set(members)),
  } as any;
}

function build(
  admins: string[],
  queue = makeQueue(),
  relay = makeRelay(),
): RoomAdminsService {
  return new RoomAdminsService(
    makeConfig(admins),
    queue as unknown as Queue,
    relay as unknown as RelayWriter,
  );
}

describe('RoomAdminsService', () => {
  describe('construction / parse', () => {
    it('throws on a malformed configured admin (fail fast at construct)', () => {
      expect(() => build(['not-a-pubkey'])).toThrow(/unparseable/i);
    });

    it('de-dups + normalizes the configured set', () => {
      const svc = build([hex(1), hex(1).toUpperCase()]);
      expect(svc.admins).toEqual([hex(1)]);
    });
  });

  describe('isConfiguredAdmin (exemption predicate)', () => {
    it('true for a configured admin, false otherwise', () => {
      const svc = build([hex(1)]);
      expect(svc.isConfiguredAdmin(hex(1))).toBe(true);
      expect(svc.isConfiguredAdmin(hex(2))).toBe(false);
      expect(svc.isConfiguredAdmin(null)).toBe(false);
    });
  });

  describe('seedRoomAdmins', () => {
    it('enqueues one 9000 role=admin per configured admin with the §18 job options', async () => {
      const queue = makeQueue();
      const svc = build([hex(1), hex(2)], queue);

      const count = await svc.seedRoomAdmins(SALE);

      expect(count).toBe(2);
      expect(queue.add).toHaveBeenCalledTimes(2);
      const [job, opts] = addCall(queue);
      expect(job.groupId).toBe(SALE);
      expect(job.meta.saleAddress).toBe(SALE);
      expect(job.template.kind).toBe(9000);
      expect(job.template.tags[0]).toEqual(['h', SALE]);
      expect(job.template.tags[1]).toEqual(['p', hex(1), NIP29_ROLE_ADMIN]);
      // §18 retry/backoff contract: attempts = maxRetries + 1, capped backoff.
      expect(opts.attempts).toBe(6);
      expect(opts.backoff).toEqual({ type: TGR_CAPPED_BACKOFF });
    });

    it('no configured admins → no enqueue (returns 0)', async () => {
      const queue = makeQueue();
      const svc = build([], queue);
      expect(await svc.seedRoomAdmins(SALE)).toBe(0);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('missing saleAddress → no enqueue', async () => {
      const queue = makeQueue();
      const svc = build([hex(1)], queue);
      expect(await svc.seedRoomAdmins('')).toBe(0);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('idempotency: calling twice enqueues the same publishes again (relay no-op)', async () => {
      const queue = makeQueue();
      const svc = build([hex(1)], queue);
      await svc.seedRoomAdmins(SALE);
      await svc.seedRoomAdmins(SALE);
      // The relay collapses replays of the same 9000; the producer simply
      // re-enqueues — no dedupe ledger here.
      expect(queue.add).toHaveBeenCalledTimes(2);
    });
  });

  describe('onRoomCreated', () => {
    it('seeds admins on tgr.room.created', async () => {
      const queue = makeQueue();
      const svc = build([hex(1)], queue);
      await svc.onRoomCreated({ saleAddress: SALE });
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('ignores a payload without a saleAddress', async () => {
      const queue = makeQueue();
      const svc = build([hex(1)], queue);
      await svc.onRoomCreated({} as any);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('convergeRoomAdmins', () => {
    it('promotes configured-not-yet-admin (9000 role=admin)', async () => {
      const queue = makeQueue();
      const svc = build([hex(1), hex(2)], queue);

      const n = await svc.convergeRoomAdmins(SALE, [hex(1), BOT]);

      expect(n).toBe(1);
      const [job] = addCall(queue);
      expect(job.template.kind).toBe(9000);
      expect(job.template.tags[1]).toEqual(['p', hex(2), NIP29_ROLE_ADMIN]);
    });

    it('demotes admin-no-longer-configured (9006 set-roles=member)', async () => {
      const queue = makeQueue();
      const svc = build([hex(1)], queue);

      const n = await svc.convergeRoomAdmins(SALE, [hex(1), hex(2), BOT]);

      expect(n).toBe(1);
      const [job] = addCall(queue);
      expect(job.template.kind).toBe(9006);
      expect(job.template.tags[1]).toEqual(['p', hex(2), NIP29_ROLE_MEMBER]);
    });

    it('equal sets → no publishes', async () => {
      const queue = makeQueue();
      const svc = build([hex(1)], queue);
      const n = await svc.convergeRoomAdmins(SALE, [hex(1), BOT]);
      expect(n).toBe(0);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('never demotes the bot key (last-admin guard respected)', async () => {
      const queue = makeQueue();
      // No configured admins; bot is the sole current admin.
      const svc = build([], queue);
      const n = await svc.convergeRoomAdmins(SALE, [BOT]);
      expect(n).toBe(0);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('falls back to fetchGroupMembers when no current set is supplied', async () => {
      const queue = makeQueue();
      const relay = makeRelay([hex(1), BOT]);
      const svc = build([hex(1), hex(2)], queue, relay);

      const n = await svc.convergeRoomAdmins(SALE);

      expect(relay.fetchGroupMembers).toHaveBeenCalledWith(SALE);
      expect(n).toBe(1); // promote hex(2)
    });
  });
});
