import 'dotenv/config';
import { generateSecretKey, getPublicKey, nip19, Relay } from 'nostr-tools';
import WebSocket from 'ws';
import { createGroup, editMetadata, putUser, setRoles } from '../nip29';
import { RelayWriterService } from '../relay-writer.service';
import { RelayAdminHealthService } from '../relay-admin-health';
import { diffRoomAdmins } from '../room-admins';

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
}

/**
 * Relay integration for Task 08 (relay-admin + configured room admins). Runs
 * against the local `groups_relay` (Task 02 harness, `ws://localhost:8080`,
 * relay-admin keypair from `settings.test.yml`). The bot nsec under test MUST be
 * the relay admin (D7).
 *
 * Skipped automatically when `TG_RELAY_URL` is unset AND no relay is reachable
 * at the default URL, so unit-only CI stays green without the relay container.
 *
 * The publish path (the queue) is exercised by unit tests; here we publish the
 * admin `9000`s straight through the writer (what the queue's processor does) and
 * assert the relay's `39001` (admins) / `39002` (members) reflect them.
 */

// Relay-admin nsec derived from settings.test.yml secret (same as Task 07 IT).
const RELAY_ADMIN_NSEC =
  process.env.TG_BOT_NSEC ||
  'nsec1dwg3l5mumawgr4xq4kc6klagytkj2w4s4kd2rrthy47g3v5mwx8qwrh7sx';
const RELAY_URL = process.env.TG_RELAY_URL || 'ws://localhost:8080';

function makeConfig(url: string, nsec: string): any {
  return {
    nostrRelayUrl: url,
    nostrBotNsec: nsec,
    publishAckTimeoutMs: 5000,
    publishRatePerSec: 100,
    publishMaxRetries: 5,
    relayHealthPauseSec: 1,
  };
}

async function relayReachable(url: string): Promise<boolean> {
  try {
    const relay = await Relay.connect(url);
    relay.close();
    return true;
  } catch {
    return false;
  }
}

/** Read the relay-served `39001` admins list (`d` tag = group id) → hex set. */
async function read39001Admins(url: string, gid: string): Promise<Set<string>> {
  const relay = await Relay.connect(url);
  const admins = new Set<string>();
  return await new Promise<Set<string>>((resolve) => {
    const done = (): void => {
      try {
        relay.close();
      } catch {
        // ignore
      }
      resolve(admins);
    };
    const sub = relay.subscribe([{ kinds: [39001], '#d': [gid] }], {
      onevent: (event) => {
        for (const tag of event.tags) {
          if (tag[0] === 'p' && typeof tag[1] === 'string') {
            admins.add(tag[1]);
          }
        }
      },
      oneose: () => {
        sub.close();
        done();
      },
    });
    setTimeout(done, 4000);
  });
}

const uniqueGid = (): string =>
  `ct_TgrAdminsIT_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

/** A random valid relay member keypair (so the relay accepts the `p` tag). */
function randomPubkey(): string {
  return getPublicKey(generateSecretKey());
}

describe('Task 08 relay admins (integration)', () => {
  let available = false;

  beforeAll(async () => {
    available = !!process.env.TG_RELAY_URL || (await relayReachable(RELAY_URL));
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(
        `[room-admins.integration] skipping — no reachable relay at ${RELAY_URL}`,
      );
    }
  }, 30000);

  const itRelay = (name: string, fn: () => Promise<void>, timeout = 20000) =>
    it(
      name,
      async () => {
        if (!available) {
          return;
        }
        await fn();
      },
      timeout,
    );

  itRelay(
    'seeding admins puts each configured admin into 39001 (admins) and 39002 (members)',
    async () => {
      const writer = new RelayWriterService(
        makeConfig(RELAY_URL, RELAY_ADMIN_NSEC),
      );
      await writer.onModuleInit();
      const gid = uniqueGid();
      const adminA = randomPubkey();
      const adminB = randomPubkey();

      await writer.publish(createGroup(gid));
      await writer.publish(
        editMetadata(gid, { name: '$ADM', isPrivate: false }),
      );

      expect((await writer.publish(putUser(gid, adminA, 'admin'))).ok).toBe(
        true,
      );
      expect((await writer.publish(putUser(gid, adminB, 'admin'))).ok).toBe(
        true,
      );
      await new Promise((r) => setTimeout(r, 600));

      const admins = await read39001Admins(RELAY_URL, gid);
      expect(admins.has(adminA)).toBe(true);
      expect(admins.has(adminB)).toBe(true);

      const members = await writer.fetchGroupMembers(gid);
      expect(members.has(adminA)).toBe(true);
      expect(members.has(adminB)).toBe(true);

      writer.onApplicationShutdown();
    },
  );

  itRelay(
    'idempotency: re-seeding the same admin produces no duplicate in 39001',
    async () => {
      const writer = new RelayWriterService(
        makeConfig(RELAY_URL, RELAY_ADMIN_NSEC),
      );
      await writer.onModuleInit();
      const gid = uniqueGid();
      const admin = randomPubkey();

      await writer.publish(createGroup(gid));
      await writer.publish(putUser(gid, admin, 'admin'));
      await writer.publish(putUser(gid, admin, 'admin')); // re-seed
      await new Promise((r) => setTimeout(r, 600));

      const admins = await read39001Admins(RELAY_URL, gid);
      const occurrences = [...admins].filter((p) => p === admin).length;
      expect(occurrences).toBe(1);

      writer.onApplicationShutdown();
    },
  );

  itRelay(
    'converge: a 9006 set-roles=member demotes an admin no longer configured',
    async () => {
      const writer = new RelayWriterService(
        makeConfig(RELAY_URL, RELAY_ADMIN_NSEC),
      );
      await writer.onModuleInit();
      const gid = uniqueGid();
      const keep = randomPubkey();
      const drop = randomPubkey();

      await writer.publish(createGroup(gid));
      await writer.publish(putUser(gid, keep, 'admin'));
      await writer.publish(putUser(gid, drop, 'admin'));
      await new Promise((r) => setTimeout(r, 600));

      const before = await read39001Admins(RELAY_URL, gid);
      expect(before.has(drop)).toBe(true);

      // diffRoomAdmins(configured=[keep], current=before, bot) → demote `drop`.
      const { toDemote } = diffRoomAdmins([keep], [...before], writer.pubkey);
      expect(toDemote).toContain(drop);
      for (const hex of toDemote) {
        await writer.publish(setRoles(gid, hex, ['member']));
      }
      await new Promise((r) => setTimeout(r, 600));

      const after = await read39001Admins(RELAY_URL, gid);
      expect(after.has(keep)).toBe(true);
      expect(after.has(drop)).toBe(false);

      writer.onApplicationShutdown();
    },
  );

  itRelay(
    'health-check: the correct relay-admin key passes; a non-admin key fails fast',
    async () => {
      // Correct admin key passes.
      const okWriter = new RelayWriterService(
        makeConfig(RELAY_URL, RELAY_ADMIN_NSEC),
      );
      await okWriter.onModuleInit();
      const okHealth = new RelayAdminHealthService(
        makeConfig(RELAY_URL, RELAY_ADMIN_NSEC),
        okWriter,
      );
      await expect(okHealth.verify()).resolves.toBeUndefined();
      okWriter.onApplicationShutdown();

      // A freshly-generated non-admin key must fail fast (mismatch and/or the
      // relay rejects its managed-create over a pre-existing h-tag).
      const strangerNsec = nip19.nsecEncode(generateSecretKey());
      const badWriter = new RelayWriterService(
        makeConfig(RELAY_URL, strangerNsec),
      );
      await badWriter.onModuleInit();
      const badHealth = new RelayAdminHealthService(
        makeConfig(RELAY_URL, strangerNsec),
        badWriter,
      );
      await expect(badHealth.verify()).rejects.toThrow();
      badWriter.onApplicationShutdown();
    },
    40000,
  );
});
