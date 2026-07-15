import 'dotenv/config';
import { Relay } from 'nostr-tools';
import WebSocket from 'ws';
import { RelayWriterService } from '../relay-writer.service';
import { createGroup, editMetadata, putUser, removeUser } from '../nip29';

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
}

/**
 * Relay-write integration (Task 07). Runs against a local `groups_relay`
 * (Task 02 harness: `ws://localhost:8080`, relay-admin keypair from
 * `settings.test.yml`). The bot nsec under test MUST be the relay admin (D7) so
 * managed-group creation is allowed.
 *
 * Skipped automatically when `TG_RELAY_URL` is unset OR the relay is not
 * reachable, so unit-only CI stays green without the relay container.
 */

// Relay-admin nsec derived from settings.test.yml secret
// 6b911fd37cdf5c81d4c0adb1ab7fa822ed253ab0ad9aa18d77257c88b29b718e
// → pubkey 385c3a6ec0b9d57a4330dbd6284989be5bd00e41c535f9ca39b6ae7c521b81cd
const RELAY_ADMIN_NSEC =
  process.env.TG_BOT_NSEC ||
  'nsec1dwg3l5mumawgr4xq4kc6klagytkj2w4s4kd2rrthy47g3v5mwx8qwrh7sx';

const RELAY_URL = process.env.TG_RELAY_URL || 'ws://localhost:8080';

function makeConfig(url: string): any {
  return {
    nostrRelayUrl: url,
    nostrBotNsec: RELAY_ADMIN_NSEC,
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

/** Read the relay-served `39000` group state (its `d` tag is the group id). */
async function read39000(url: string, groupId: string): Promise<boolean> {
  const relay = await Relay.connect(url);
  return await new Promise<boolean>((resolve) => {
    let found = false;
    const sub = relay.subscribe([{ kinds: [39000], '#d': [groupId] }], {
      onevent: () => {
        found = true;
      },
      oneose: () => {
        sub.close();
        relay.close();
        resolve(found);
      },
    });
    setTimeout(() => {
      try {
        sub.close();
        relay.close();
      } catch {
        // ignore
      }
      resolve(found);
    }, 4000);
  });
}

const uniqueGid = (): string =>
  `ct_TgrWriterIT_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const memberPk = (n = 0): string =>
  (n.toString(16).padStart(2, '0') + 'a'.repeat(62)).slice(0, 64);

describe('RelayWriterService (integration)', () => {
  let available = false;

  beforeAll(async () => {
    available = !!process.env.TG_RELAY_URL || (await relayReachable(RELAY_URL));
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(
        `[relay-writer.integration] skipping — no reachable relay at ${RELAY_URL}`,
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
    'publishes 9007 + 9002 (closed) and the relay serves a 39000',
    async () => {
      const writer = new RelayWriterService(makeConfig(RELAY_URL));
      await writer.onModuleInit();
      const gid = uniqueGid();

      const created = await writer.publish(createGroup(gid));
      expect(created.ok).toBe(true);

      const meta = await writer.publish(
        editMetadata(gid, {
          name: '$IT',
          about: 'integration room',
          isPrivate: false,
        }),
      );
      expect(meta.ok).toBe(true);

      // Relay generates the addressable 39000 state for the group.
      await new Promise((r) => setTimeout(r, 500));
      expect(await read39000(RELAY_URL, gid)).toBe(true);

      writer.onApplicationShutdown();
    },
  );

  itRelay(
    '9000 put-user adds to 39002, 9001 removes; fetchGroupMembers reflects both',
    async () => {
      const writer = new RelayWriterService(makeConfig(RELAY_URL));
      await writer.onModuleInit();
      const gid = uniqueGid();
      const pk = memberPk(1);

      await writer.publish(createGroup(gid));
      await writer.publish(
        editMetadata(gid, { name: '$IT2', isPrivate: false }),
      );

      const add = await writer.publish(putUser(gid, pk));
      expect(add.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 500));

      const afterAdd = await writer.fetchGroupMembers(gid);
      expect(afterAdd.has(pk)).toBe(true);

      const remove = await writer.publish(removeUser(gid, pk));
      expect(remove.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 500));

      const afterRemove = await writer.fetchGroupMembers(gid);
      expect(afterRemove.has(pk)).toBe(false);

      writer.onApplicationShutdown();
    },
  );

  itRelay(
    'duplicate 9007 for an existing group resolves (already-exists no-op)',
    async () => {
      const writer = new RelayWriterService(makeConfig(RELAY_URL));
      await writer.onModuleInit();
      const gid = uniqueGid();

      const first = await writer.publish(createGroup(gid));
      expect(first.ok).toBe(true);

      // A second create either ok-acks or rejects with "Group already exists";
      // the writer surfaces the reason and the PROCESSOR treats it as success.
      const second = await writer.publish(createGroup(gid));
      if (!second.ok) {
        expect(second.reason.toLowerCase()).toContain('already exists');
      }

      // 39000 still served (group unchanged).
      expect(await read39000(RELAY_URL, gid)).toBe(true);

      writer.onApplicationShutdown();
    },
  );

  itRelay(
    'unreachable relay: publish reports failure and the writer is unhealthy (queue would pause)',
    async () => {
      // Point at a closed port — connect fails, publish must not hang forever.
      const writer = new RelayWriterService(makeConfig('ws://127.0.0.1:1'));
      // onModuleInit schedules a reconnect on failure instead of throwing.
      await writer.onModuleInit();
      expect(writer.isHealthy()).toBe(false);

      await expect(
        writer.publish(createGroup(uniqueGid())),
      ).rejects.toBeDefined();
      expect(writer.isHealthy()).toBe(false);

      writer.onApplicationShutdown();
    },
  );
});
