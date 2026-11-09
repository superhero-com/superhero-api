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
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bull';
import { PublishNip29Processor } from '../../queues/publish-nip29.processor';
import type { PublishNip29Job } from '../../queues/publish-nip29.types';
import { TGR_PUBLISH_ACK, TGR_RELAY_READY } from '../../events';
import { getTgrMetricsSnapshot } from '../../observability/tgr-metrics';
import { createGroup } from '../nip29';
import { RELAY_ADMIN_PUBKEY_ENV } from '../relay-admin-identity';
import { RelayWriterService } from '../relay-writer.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RelayWriterService against a NIP-42 relay', () => {
  let relay: FakeRelay;
  let writer: RelayWriterService;
  let nip11: jest.SpyInstance;
  let savedAdminFallback: string | undefined;
  let writerEvents: EventEmitter2;

  const relayInfo = (pubkey?: string) =>
    ({ ok: true, json: async () => ({ pubkey }) }) as Response;

  beforeEach(() => {
    relay = undefined;
    writer = undefined;
    savedAdminFallback = process.env[RELAY_ADMIN_PUBKEY_ENV];
    delete process.env[RELAY_ADMIN_PUBKEY_ENV];
    writerEvents = new EventEmitter2();
    nip11 = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => relayInfo(writer.pubkey));
  });

  async function start(
    options: FakeRelayOptions = {},
    publishAckTimeoutMs = 1000,
  ): Promise<void> {
    relay = await startFakeRelay(options);
    writer = new RelayWriterService(
      {
        nostrRelayUrl: relay.url,
        nostrBotNsec: nip19.nsecEncode(generateSecretKey()),
        publishAckTimeoutMs,
        relayHealthPauseSec: 1,
      } as any,
      writerEvents,
    );
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
    nip11.mockRestore();
    jest.restoreAllMocks();
    if (savedAdminFallback === undefined) {
      delete process.env[RELAY_ADMIN_PUBKEY_ENV];
    } else {
      process.env[RELAY_ADMIN_PUBKEY_ENV] = savedAdminFallback;
    }
  });

  describe('authentication', () => {
    it('keeps the API relay path dormant when relay configuration is blank', async () => {
      const ready = jest.fn();
      writerEvents.on(TGR_RELAY_READY, ready);
      writer = new RelayWriterService(
        { nostrRelayUrl: '', nostrBotNsec: '' } as any,
        writerEvents,
      );
      await writer.onModuleInit();
      expect(writer.isHealthy()).toBe(false);
      expect(writer.pubkey).toBe('');
      expect(nip11).not.toHaveBeenCalled();
      expect(ready).not.toHaveBeenCalled();
    });

    it('becomes healthy after AUTH and matching NIP-11 admin identity', async () => {
      await start();
      await healthy();
      expect(relay.authenticated).toBe(1);
      expect(nip11).toHaveBeenCalledTimes(1);
    });

    it('keeps publishing paused across fresh jobs until the relay admin configuration is corrected', async () => {
      nip11.mockResolvedValue(relayInfo(getPublicKey(generateSecretKey())));
      // This must return while relay setup is incomplete, allowing API bootstrap.
      await start();
      await firstSocketClosed();
      expect(relay.authenticated).toBe(1);
      expect(writer.isHealthy()).toBe(false);

      let paused = false;
      const queue = {
        isPaused: jest.fn(async () => paused),
        pause: jest.fn(async () => {
          paused = true;
        }),
        resume: jest.fn(async () => {
          paused = false;
        }),
      };
      const emitter = new EventEmitter2();
      const ack = jest.fn();
      emitter.on(TGR_PUBLISH_ACK, ack);
      const processor = new PublishNip29Processor(
        writer,
        emitter,
        { publishRatePerSec: 1000, relayHealthPauseSec: 1 } as any,
        queue as unknown as Queue<PublishNip29Job>,
      );
      const job = (groupId: string) =>
        ({
          data: { groupId, template: createGroup(groupId) },
        }) as Job<PublishNip29Job>;
      try {
        // Model newly provisioned jobs on successive scans, not Bull retries.
        for (const groupId of ['ct_first', 'ct_second', 'ct_first']) {
          await expect(processor.process(job(groupId))).rejects.toThrow(
            'relay unhealthy',
          );
        }
        expect(relay.events).toHaveLength(0);
        expect(ack).not.toHaveBeenCalled();
        expect(paused).toBe(true);

        nip11.mockImplementation(async () => relayInfo(writer.pubkey));
        await healthy();
        await waitForRelayState(
          async () => paused,
          (value) => !value,
        );
        await expect(
          processor.process(job('ct_first')),
        ).resolves.toHaveProperty('id');
        expect(relay.events).toHaveLength(1);
        expect(ack).toHaveBeenCalledWith(
          expect.objectContaining({ ok: true, kind: 9007 }),
        );
      } finally {
        processor.onApplicationShutdown();
      }
    }, 15_000);

    it('does not become healthy while NIP-11 is still pending after AUTH', async () => {
      let finish: (response: Response) => void;
      nip11.mockReturnValue(
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
      );
      await start();
      await waitForRelayState(
        async () => relay.authenticated,
        (value) => value === 1,
      );
      expect(writer.isHealthy()).toBe(false);
      finish(relayInfo(writer.pubkey));
      await healthy();
    });

    it('checks admin identity again after a reconnect', async () => {
      const errors = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      await start();
      await healthy();
      nip11.mockResolvedValue(relayInfo(getPublicKey(generateSecretKey())));
      relay.dropAll();
      await waitForRelayState(
        async () => relay.connections === 2 && relay.openSockets() === 0,
        Boolean,
      );
      expect(writer.isHealthy()).toBe(false);
      expect(relay.authenticated).toBe(2);
      expect(nip11).toHaveBeenCalledTimes(2);
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('relay reconnect failed'),
      );
    }, 10_000);

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

  describe('verification completing on a stale connection', () => {
    it.each(['shutdown', 'socket closure', 'replacement'])(
      'does not signal readiness after %s',
      async (change) => {
        let finish: (response: Response) => void;
        nip11.mockReturnValue(
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
        );
        const ready = jest.fn();
        writerEvents.on(TGR_RELAY_READY, ready);
        await start();
        await waitForRelayState(
          async () => relay.authenticated,
          (count) => count === 1,
        );
        const pending = writer.publish(createGroup('ct_stale'));
        const replacement = { connected: true, close: jest.fn() };
        if (change === 'shutdown') {
          writer.onApplicationShutdown();
        } else if (change === 'socket closure') {
          relay.dropAll();
          await firstSocketClosed();
        } else {
          (writer as any).relay = replacement;
        }
        finish(relayInfo(writer.pubkey));
        await expect(pending).rejects.toThrow(
          'relay disconnected during admin verification',
        );
        expect(writer.isHealthy()).toBe(false);
        expect(getTgrMetricsSnapshot().relayWriterConnected).toBe(false);
        expect(ready).not.toHaveBeenCalled();
        expect(replacement.close).not.toHaveBeenCalled();
        expect(relay.events).toHaveLength(0);
      },
    );
  });

  describe('publish authority', () => {
    const adminReject =
      'error: Only relay admin can create a managed group from an unmanaged one';

    it('marks a live connection unhealthy on admin rejection and requires authoritative identity before recovery', async () => {
      await start({
        onEvent: (send, event) => send(['OK', event.id, false, adminReject]),
      });
      await healthy();

      // A fallback that merely repeats our bot key cannot override the relay's
      // explicit denial; otherwise reconnecting would recreate the same flood.
      process.env[RELAY_ADMIN_PUBKEY_ENV] = writer.pubkey;
      nip11.mockResolvedValue(relayInfo());
      await expect(
        writer.publish(createGroup('ct_denied')),
      ).resolves.toMatchObject({
        ok: false,
        reason: adminReject,
      });
      expect(writer.isHealthy()).toBe(false);
      await waitForRelayState(
        async () => relay.connections === 2 && relay.openSockets() === 0,
        Boolean,
      );
      expect(writer.isHealthy()).toBe(false);
      expect(relay.events).toHaveLength(1);

      nip11.mockImplementation(async () => relayInfo(writer.pubkey));
      await healthy();
    }, 15_000);

    it('keeps a verified connection healthy for a group-specific rejection', async () => {
      await start({
        onEvent: (send, event) =>
          send(['OK', event.id, false, 'Group existed before and was deleted']),
      });
      await healthy();
      await expect(
        writer.publish(createGroup('ct_deleted')),
      ).resolves.toMatchObject({ ok: false });
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

    it('reconnects after a read times out, like after a publish timeout', async () => {
      await start({ onReq: () => undefined });
      await healthy();

      await expect(writer.fetchGroupMembers('ct_room')).rejects.toThrow(
        'timed out',
      );
      expect(writer.isHealthy()).toBe(false);
      await waitForRelayState(
        async () => relay.authenticated,
        (n) => n === 2,
      );
      await healthy();
      expect(relay.connections).toBe(2);
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
