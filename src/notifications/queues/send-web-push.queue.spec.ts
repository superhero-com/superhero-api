import { WebPushError } from 'web-push';
import { SendWebPushQueue } from './send-web-push.queue';

describe('SendWebPushQueue', () => {
  let client: any;
  let subscriptions: any;
  let dedup: any;
  let processor: SendWebPushQueue;

  const data = {
    subscription: {
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p', auth: 'a' },
    },
    payload: { title: 't', body: 'b' },
    dedupKey: 'web-push:post-comment:th_1:ak_owner',
  };

  const job = (overrides: any = {}) => ({
    data,
    opts: { attempts: 5 },
    attemptsMade: 0,
    ...overrides,
  });

  const webPushErr = (statusCode: number) =>
    new WebPushError(
      'boom',
      statusCode,
      {} as any,
      '',
      data.subscription.endpoint,
    );

  beforeEach(() => {
    client = { send: jest.fn().mockResolvedValue(undefined) };
    subscriptions = { prune: jest.fn().mockResolvedValue(undefined) };
    dedup = { release: jest.fn().mockResolvedValue(undefined) };
    processor = new SendWebPushQueue(client, subscriptions, dedup);
  });

  it('sends and does not prune or release on success', async () => {
    await processor.process(job() as any);
    expect(client.send).toHaveBeenCalledWith(data.subscription, data.payload);
    expect(subscriptions.prune).not.toHaveBeenCalled();
    expect(dedup.release).not.toHaveBeenCalled();
  });

  it('prunes the dead subscription on a 410 and completes (no retry)', async () => {
    client.send.mockRejectedValue(webPushErr(410));
    await expect(processor.process(job() as any)).resolves.toBeUndefined();
    expect(subscriptions.prune).toHaveBeenCalledWith(
      data.subscription.endpoint,
    );
    expect(dedup.release).not.toHaveBeenCalled();
  });

  it('drops a permanent failure (400) without prune or retry', async () => {
    client.send.mockRejectedValue(webPushErr(400));
    await expect(processor.process(job() as any)).resolves.toBeUndefined();
    expect(subscriptions.prune).not.toHaveBeenCalled();
    expect(dedup.release).not.toHaveBeenCalled();
  });

  it('logs a permanent failure at ERROR level unconditionally (survives production, which keeps only error logs)', async () => {
    // Regression: a permanent failure must be logged at `.error`, not `.warn`
    // — main.ts keeps only error-level logs when DEBUG_ENABLED is off, so a
    // warn() here would be silently dropped in production. Without this, a
    // broken VAPID config (or any 400/403/413) can fail every single send with
    // zero operator-visible signal.
    const errorSpy = jest.spyOn((processor as any).logger, 'error');
    client.send.mockRejectedValue(webPushErr(403));

    await processor.process(job() as any);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(data.subscription.endpoint),
    );
  });

  it('rethrows a retryable failure without releasing dedup on a non-final attempt', async () => {
    client.send.mockRejectedValue(webPushErr(503));
    await expect(
      processor.process(job({ attemptsMade: 0 }) as any),
    ).rejects.toThrow();
    expect(dedup.release).not.toHaveBeenCalled();
  });

  it('releases the dedup key on the final exhausted retry so a re-observation can re-deliver', async () => {
    client.send.mockRejectedValue(webPushErr(503));
    await expect(
      processor.process(job({ attemptsMade: 4, opts: { attempts: 5 } }) as any),
    ).rejects.toThrow();
    expect(dedup.release).toHaveBeenCalledWith(data.dedupKey);
  });
});
