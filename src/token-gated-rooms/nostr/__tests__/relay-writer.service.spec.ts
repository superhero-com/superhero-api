import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
} from 'nostr-tools';
import {
  FakeRelay,
  FakeRelayOptions,
  startFakeRelay,
} from '@/test/harness/fake-relay';
import { waitForRelayState } from '@/test/harness/relay';
import { RelayWriterService } from '../relay-writer.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RelayWriterService against a NIP-42 relay', () => {
  let relay: FakeRelay;
  let writer: RelayWriterService;

  async function start(
    options: FakeRelayOptions = {},
    publishAckTimeoutMs = 1000,
  ): Promise<void> {
    relay = await startFakeRelay(options);
    writer = new RelayWriterService({
      nostrRelayUrl: relay.url,
      nostrBotNsec: nip19.nsecEncode(generateSecretKey()),
      publishAckTimeoutMs,
      relayHealthPauseSec: 1,
    } as any);
    await writer.onModuleInit();
  }
  const healthy = () =>
    waitForRelayState(async () => writer.isHealthy(), Boolean);
  const firstSocketClosed = () =>
    waitForRelayState(
      async () => relay.connections === 1 && relay.openSockets() === 0,
      Boolean,
    );

  afterEach(async () => {
    writer?.onApplicationShutdown();
    await relay?.close();
  });

  describe('authentication', () => {
    it('becomes healthy once the relay acknowledges AUTH', async () => {
      await start();
      await healthy();
      expect(relay.authenticated).toBe(1);
    });

    it('waits for a challenge sent after the socket opens', async () => {
      await start({ challengeDelayMs: 100 });
      await healthy();
      expect(relay.authenticated).toBe(1);
    });

    it('stays unhealthy and drops the socket when AUTH is rejected', async () => {
      await start({ rejectAuth: 'auth-required: relay mismatch' });
      await firstSocketClosed();
      expect(writer.isHealthy()).toBe(false);
      expect(relay.authenticated).toBe(0);
    });

    it('stays unhealthy when the relay never challenges', async () => {
      await start({ challengeDelayMs: null }, 300);
      await firstSocketClosed();
      expect(writer.isHealthy()).toBe(false);
      expect(relay.authenticated).toBe(0);
    });

    it('is not healthy until a reconnect re-authenticates', async () => {
      await start({ challengeDelayMs: 500 }, 2000);
      await healthy();

      const reconnecting = (writer as any).reconnect();
      await waitForRelayState(
        async () => (writer as any).relay?.connected,
        Boolean,
      );
      expect(writer.isHealthy()).toBe(false);
      await reconnecting;
      expect(writer.isHealthy()).toBe(true);
    });
  });

  describe('membership reads', () => {
    const member = getPublicKey(generateSecretKey());
    const membersEvent = (groupId: string) =>
      finalizeEvent(
        {
          kind: 39002,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['d', groupId],
            ['p', member],
          ],
          content: '',
        },
        generateSecretKey(),
      );
    const groupOf = (filter: Record<string, unknown>) =>
      (filter['#d'] as string[])[0];

    it('collects 39002 members until EOSE', async () => {
      await start({
        onReq: (send, subId, [filter]) => {
          if (groupOf(filter) === 'ct_room') {
            send(['EVENT', subId, membersEvent('ct_room')]);
          }
          send(['EOSE', subId]);
        },
      });
      await healthy();

      await expect(writer.fetchGroupMembers('ct_room')).resolves.toEqual(
        new Set([member]),
      );
      await expect(writer.fetchGroupMembers('ct_empty')).resolves.toEqual(
        new Set(),
      );
      // A read left open would leak a relay subscription on every reconcile.
      expect((writer as any).relay.openSubs.size).toBe(0);
    });

    it('rejects a read the relay closes instead of reporting no members', async () => {
      await start({
        onReq: (send, subId) =>
          send(['CLOSED', subId, 'auth-required: authenticate first']),
      });
      await healthy();

      await expect(writer.fetchGroupMembers('ct_room')).rejects.toThrow(
        'auth-required',
      );
    });

    it('rejects a read without EOSE instead of returning partial members', async () => {
      // Above nostr-tools' 4.4 s synthetic EOSE, like the 5 s production default.
      await start(
        {
          onReq: (send, subId, [filter]) =>
            send(['EVENT', subId, membersEvent(groupOf(filter))]),
        },
        4500,
      );
      await healthy();

      await expect(writer.fetchGroupMembers('ct_room')).rejects.toThrow(
        'timed out',
      );
      expect((writer as any).relay.openSubs.size).toBe(0);
    }, 15_000);
  });

  it('reconnects once after the relay drops the socket', async () => {
    await start();
    await healthy();

    relay.dropAll();
    await waitForRelayState(
      async () => relay.authenticated,
      (n) => n === 2,
    );
    // A reconnect loop would open a third socket within 3 s.
    await sleep(3000);

    expect(relay.connections).toBe(2);
    expect(writer.isHealthy()).toBe(true);
  }, 15_000);
});
