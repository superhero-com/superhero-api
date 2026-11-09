import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job, Queue } from 'bull';
import {
  generateSecretKey,
  getPublicKey,
  nip19,
  verifyEvent,
} from 'nostr-tools';
import { startFakeRelay, type FakeRelay } from '@/test/harness/fake-relay';
import { waitForRelayState } from '@/test/harness/relay';
import { TGR_PUBLISH_ACK, type TgrPublishAckPayload } from '../../events';
import { PublishNip29Processor } from '../../queues/publish-nip29.processor';
import type { PublishNip29Job } from '../../queues/publish-nip29.types';
import {
  createGroup,
  editMetadata,
  putUser,
  removeUser,
  type Nip29Template,
} from '../nip29';
import { RELAY_ADMIN_PUBKEY_ENV } from '../relay-admin-identity';
import { RelayWriterService } from '../relay-writer.service';

/** Real HTTP NIP-11 + WebSocket AUTH/publishing; no mocked fetch or writer. */
describe('configured relay publishing over HTTP and WebSocket', () => {
  let relay: FakeRelay;
  let writer: RelayWriterService;
  let processor: PublishNip29Processor;
  let savedFallback: string | undefined;

  beforeEach(() => {
    savedFallback = process.env[RELAY_ADMIN_PUBKEY_ENV];
    delete process.env[RELAY_ADMIN_PUBKEY_ENV];
  });

  afterEach(async () => {
    processor?.onApplicationShutdown();
    writer?.onApplicationShutdown();
    await relay?.close();
    if (savedFallback === undefined) {
      delete process.env[RELAY_ADMIN_PUBKEY_ENV];
    } else {
      process.env[RELAY_ADMIN_PUBKEY_ENV] = savedFallback;
    }
  });

  const healthy = () =>
    waitForRelayState(async () => writer.isHealthy(), Boolean);

  function makeWriter(secret: Uint8Array): void {
    writer = new RelayWriterService(
      {
        nostrRelayUrl: `${relay.url}/nostr`,
        nostrBotNsec: nip19.nsecEncode(secret),
        publishAckTimeoutMs: 5000,
        relayHealthPauseSec: 1,
      } as any,
      new EventEmitter2(),
    );
  }

  it.each(['HTTP failure', 'timeout'])(
    'recovers from NIP-11 %s without a fallback and then publishes removals',
    async (failure) => {
      const secret = generateSecretKey();
      const admin = getPublicKey(secret);
      let available = false;
      relay = await startFakeRelay({
        onHttp: (_request, response) => {
          if (available) {
            response.writeHead(200, {
              'Content-Type': 'application/nostr+json',
            });
            response.end(JSON.stringify({ pubkey: admin }));
          } else if (failure === 'HTTP failure') {
            response.writeHead(503);
            response.end();
          }
          // Timeout case deliberately leaves the response open until fetch aborts.
        },
      });
      writer = new RelayWriterService(
        {
          nostrRelayUrl: `${relay.url}/nostr`,
          nostrBotNsec: nip19.nsecEncode(secret),
          publishAckTimeoutMs: 500,
          relayHealthPauseSec: 1,
        } as any,
        new EventEmitter2(),
      );
      await writer.onModuleInit();
      await waitForRelayState(
        async () => relay.authenticated === 1 && relay.openSockets() === 0,
        Boolean,
      );
      expect(writer.isHealthy()).toBe(false);
      expect(relay.events).toHaveLength(0);

      available = true;
      await healthy();
      await expect(
        writer.publish(removeUser('ct_recovered', admin)),
      ).resolves.toMatchObject({ ok: true });
      expect(relay.events.map((event) => event.kind)).toEqual([9001]);
    },
    15_000,
  );

  it('accepts room creation, metadata and membership publishes, duplicate creates, and reconnects with the correct admin key', async () => {
    const secret = generateSecretKey();
    const admin = getPublicKey(secret);
    const member = getPublicKey(generateSecretKey());
    const groupId = 'ct_configured';
    const infoRequests: Array<{ path: string; accept: string }> = [];
    let created = false;
    relay = await startFakeRelay({
      relayInfo: (request) => {
        infoRequests.push({
          path: request.url,
          accept: request.headers.accept,
        });
        return { pubkey: admin };
      },
      onEvent: (send, event) => {
        const duplicate = event.kind === 9007 && created;
        if (event.kind === 9007) created = true;
        send([
          'OK',
          event.id,
          !duplicate,
          duplicate ? 'Group already exists' : '',
        ]);
      },
    });
    makeWriter(secret);
    await writer.onModuleInit();
    await healthy();

    const emitter = new EventEmitter2();
    const acks: TgrPublishAckPayload[] = [];
    emitter.on(TGR_PUBLISH_ACK, (ack: TgrPublishAckPayload) => acks.push(ack));
    const pause = jest.fn();
    processor = new PublishNip29Processor(
      writer,
      emitter,
      { publishRatePerSec: 1000, relayHealthPauseSec: 1 } as any,
      { pause } as unknown as Queue<PublishNip29Job>,
    );
    const publish = (template: Nip29Template) =>
      processor.process({
        data: { groupId, template },
      } as Job<PublishNip29Job>);

    await publish(createGroup(groupId));
    await publish(
      editMetadata(groupId, { name: 'Configured room', isPrivate: true }),
    );
    await publish(putUser(groupId, member));
    await publish(createGroup(groupId));
    expect(writer.isHealthy()).toBe(true);
    expect(pause).not.toHaveBeenCalled();

    relay.dropAll();
    await waitForRelayState(
      async () => relay.authenticated,
      (count) => count === 2,
    );
    await healthy();
    await publish(removeUser(groupId, member));

    expect(relay.events.map((event) => event.kind)).toEqual([
      9007, 9002, 9000, 9007, 9001,
    ]);
    expect(
      relay.events.every(
        (event) => event.pubkey === admin && verifyEvent(event),
      ),
    ).toBe(true);
    expect(acks.map(({ kind, ok }) => ({ kind, ok }))).toEqual([
      { kind: 9007, ok: true },
      { kind: 9002, ok: true },
      { kind: 9000, ok: true },
      { kind: 9007, ok: true },
      { kind: 9001, ok: true },
    ]);
    expect(infoRequests).toEqual([
      { path: '/nostr', accept: 'application/nostr+json' },
      { path: '/nostr', accept: 'application/nostr+json' },
    ]);
  }, 15_000);

  it('publishes and reconnects using the documented npub fallback when NIP-11 is unavailable', async () => {
    const secret = generateSecretKey();
    const admin = getPublicKey(secret);
    process.env[RELAY_ADMIN_PUBKEY_ENV] = nip19.npubEncode(admin);
    // The HTTP endpoint returns 404, while WebSocket AUTH/publishing works.
    relay = await startFakeRelay();
    makeWriter(secret);
    await writer.onModuleInit();
    await healthy();
    await expect(
      writer.publish(createGroup('ct_fallback')),
    ).resolves.toMatchObject({ ok: true });
    relay.dropAll();
    await waitForRelayState(
      async () => relay.authenticated,
      (count) => count === 2,
    );
    await healthy();
    await expect(
      writer.publish(putUser('ct_fallback', admin)),
    ).resolves.toMatchObject({ ok: true });
    expect(relay.events).toHaveLength(2);
  }, 15_000);
});
