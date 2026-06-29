import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job, Queue } from 'bull';
import {
  TGR_GROUP_MISSING,
  TGR_PUBLISH_ACK,
  type TgrGroupMissingPayload,
  type TgrPublishAckPayload,
} from '../../events';
import type { RelayWriter } from '../../nostr/relay-writer.contract';
import { PublishNip29Processor } from '../publish-nip29.processor';
import { TerminalPublishError } from '../publish-policy';
import type { PublishNip29Job } from '../publish-nip29.types';

const PK = 'a'.repeat(64);
const GID = 'ct_Group1';

function makeConfig(overrides: Partial<Record<string, number>> = {}) {
  return {
    publishRatePerSec: 1000,
    publishAckTimeoutMs: 5000,
    publishMaxRetries: 5,
    relayHealthPauseSec: 5,
    ...overrides,
  } as any;
}

function makeQueue(): jest.Mocked<
  Pick<Queue, 'pause' | 'resume' | 'isPaused' | 'getJobCounts'>
> {
  return {
    pause: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
    isPaused: jest.fn().mockResolvedValue(false),
    getJobCounts: jest.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    }),
  } as any;
}

function makeJob(
  data: PublishNip29Job,
  opts: { attempts?: number; attemptsMade?: number } = {},
): Job<PublishNip29Job> {
  return {
    data,
    opts: { attempts: opts.attempts ?? 6 },
    attemptsMade: opts.attemptsMade ?? 0,
    discard: jest.fn(),
  } as any;
}

function membershipJob(kind = 9000): PublishNip29Job {
  return {
    template: {
      kind,
      tags: [
        ['h', GID],
        ['p', PK],
      ],
      content: '',
    },
    groupId: GID,
    meta: { saleAddress: GID },
  };
}

function groupJob(): PublishNip29Job {
  return {
    template: { kind: 9007, tags: [['h', GID]], content: '' },
    groupId: GID,
    meta: { saleAddress: GID },
  };
}

describe('PublishNip29Processor', () => {
  let relay: jest.Mocked<Pick<RelayWriter, 'isHealthy' | 'publish'>>;
  let emitter: EventEmitter2;
  let emitted: Array<{ name: string; payload: TgrPublishAckPayload }>;
  let groupMissing: TgrGroupMissingPayload[];
  let queue: ReturnType<typeof makeQueue>;
  let processor: PublishNip29Processor;

  function build(config = makeConfig()): void {
    processor = new PublishNip29Processor(
      relay as unknown as RelayWriter,
      emitter,
      config,
      queue as unknown as Queue<PublishNip29Job>,
    );
  }

  beforeEach(() => {
    relay = {
      isHealthy: jest.fn().mockReturnValue(true),
      publish: jest.fn(),
    } as any;
    emitter = new EventEmitter2();
    emitted = [];
    groupMissing = [];
    emitter.on(TGR_PUBLISH_ACK, (payload: TgrPublishAckPayload) =>
      emitted.push({ name: TGR_PUBLISH_ACK, payload }),
    );
    emitter.on(TGR_GROUP_MISSING, (payload: TgrGroupMissingPayload) =>
      groupMissing.push(payload),
    );
    queue = makeQueue();
    build();
  });

  afterEach(() => {
    // Clear the outage resume-loop timer armed by the pause tests.
    processor.onApplicationShutdown();
  });

  describe('onApplicationBootstrap (clears a stale pause after restart)', () => {
    it('resumes the queue when it boots up paused', async () => {
      queue.isPaused.mockResolvedValue(true);
      await processor.onApplicationBootstrap();
      expect(queue.resume).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the queue is not paused', async () => {
      queue.isPaused.mockResolvedValue(false);
      await processor.onApplicationBootstrap();
      expect(queue.resume).not.toHaveBeenCalled();
    });

    it('never throws if the resume check fails', async () => {
      queue.isPaused.mockRejectedValue(new Error('redis down'));
      await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });

  it('on relay ACK ok: resolves and emits tgr.publish.ack ok:true with pubkey', async () => {
    relay.publish.mockResolvedValue({ ok: true, id: 'evt1' });

    const res = await processor.process(makeJob(membershipJob()));

    expect(res).toEqual({ id: 'evt1' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual({
      saleAddress: GID,
      kind: 9000,
      ok: true,
      pubkey: PK,
    });
  });

  it('group-level publish: ack payload has no pubkey', async () => {
    relay.publish.mockResolvedValue({ ok: true, id: 'evt-g' });

    await processor.process(makeJob(groupJob()));

    expect(emitted[0].payload).toEqual({
      saleAddress: GID,
      kind: 9007,
      ok: true,
    });
    expect(emitted[0].payload.pubkey).toBeUndefined();
  });

  it('"Group already exists" reject: resolves successfully, ack ok:true, no throw', async () => {
    relay.publish.mockResolvedValue({
      ok: false,
      id: 'evt2',
      reason: 'Group already exists',
      timedOut: false,
    });

    const res = await processor.process(makeJob(groupJob()));

    expect(res).toEqual({ id: 'evt2' });
    expect(emitted[0].payload.ok).toBe(true);
    expect(emitted[0].payload.kind).toBe(9007);
  });

  it('terminal "Only relay admin…" reject: throws TerminalPublishError, ack ok:false', async () => {
    relay.publish.mockResolvedValue({
      ok: false,
      id: 'evt3',
      reason:
        'Only relay admin can create a managed group from an unmanaged one',
      timedOut: false,
    });

    await expect(processor.process(makeJob(groupJob()))).rejects.toBeInstanceOf(
      TerminalPublishError,
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.ok).toBe(false);
  });

  it('terminal "…was deleted" reject: throws TerminalPublishError, ack ok:false', async () => {
    relay.publish.mockResolvedValue({
      ok: false,
      id: 'evt3b',
      reason: 'Group existed before and was deleted',
      timedOut: false,
    });

    await expect(processor.process(makeJob(groupJob()))).rejects.toBeInstanceOf(
      TerminalPublishError,
    );
    expect(emitted[0].payload.ok).toBe(false);
  });

  it('"Group not found" on a 9000 add: discards (no retry), emits TGR_GROUP_MISSING + ack ok:false', async () => {
    relay.publish.mockResolvedValue({
      ok: false,
      id: 'evt-gm',
      reason: 'error: [PutUser] Group not found',
      timedOut: false,
    });
    const job = makeJob(membershipJob(9000));

    await expect(processor.process(job)).rejects.toThrow(/group not found/i);

    // No retry-spam: the job is discarded so Bull won't re-attempt it.
    expect(job.discard).toHaveBeenCalledTimes(1);
    // The owner is asked to re-create the group...
    expect(groupMissing).toEqual([{ saleAddress: GID }]);
    // ...and the member is left pending (ack ok:false → membership stays pending_add).
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual({
      saleAddress: GID,
      kind: 9000,
      ok: false,
      pubkey: PK,
    });
  });

  it('"Group not found" on a 9001 remove: absence already satisfied → ack ok:true, no re-create, no throw', async () => {
    relay.publish.mockResolvedValue({
      ok: false,
      id: 'evt-gm2',
      reason: 'error: [RemoveUser] Group not found',
      timedOut: false,
    });
    const job = makeJob(membershipJob(9001));

    const res = await processor.process(job);

    expect(res).toEqual({ id: 'evt-gm2' });
    expect(groupMissing).toHaveLength(0); // a remove needs no re-create
    expect(job.discard).not.toHaveBeenCalled();
    expect(emitted[0].payload.ok).toBe(true);
    expect(emitted[0].payload.kind).toBe(9001);
  });

  it('retryable reject on a NON-final attempt: throws, emits NO ack (wait for retry)', async () => {
    relay.publish.mockResolvedValue({
      ok: false,
      id: 'evt4',
      reason: 'connection reset',
      timedOut: false,
    });

    await expect(
      processor.process(
        makeJob(membershipJob(), { attempts: 6, attemptsMade: 0 }),
      ),
    ).rejects.toThrow('connection reset');
    expect(emitted).toHaveLength(0);
  });

  it('retryable reject on the FINAL attempt: throws and emits ack ok:false (exhausted)', async () => {
    relay.publish.mockResolvedValue({
      ok: false,
      id: 'evt5',
      reason: 'connection reset',
      timedOut: false,
    });

    await expect(
      processor.process(
        makeJob(membershipJob(), { attempts: 6, attemptsMade: 5 }),
      ),
    ).rejects.toThrow('connection reset');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual({
      saleAddress: GID,
      kind: 9000,
      ok: false,
      pubkey: PK,
    });
  });

  it('unhealthy relay: pauses the queue and throws WITHOUT publishing or acking', async () => {
    relay.isHealthy.mockReturnValue(false);

    await expect(processor.process(makeJob(membershipJob()))).rejects.toThrow(
      /unhealthy/,
    );
    expect(relay.publish).not.toHaveBeenCalled();
    expect(queue.pause).toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('ACK timeout reject: pauses the queue, then retries (non-final → no ack)', async () => {
    relay.publish.mockResolvedValue({
      ok: false,
      id: 'evt6',
      reason: 'relay ACK timed out after 5000ms',
      timedOut: true,
    });

    await expect(
      processor.process(
        makeJob(membershipJob(), { attempts: 6, attemptsMade: 0 }),
      ),
    ).rejects.toThrow(/timed out/);
    expect(queue.pause).toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('uses saleAddress from meta and falls back to groupId when meta omitted', async () => {
    relay.publish.mockResolvedValue({ ok: true, id: 'evt7' });
    const job = makeJob({
      template: {
        kind: 9001,
        tags: [
          ['h', GID],
          ['p', PK],
        ],
      },
      groupId: GID,
    });

    await processor.process(job);
    expect(emitted[0].payload.saleAddress).toBe(GID);
  });
});
