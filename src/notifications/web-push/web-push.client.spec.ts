import webpush, { WebPushError } from 'web-push';
import { WebPushClient } from './web-push.client';

describe('WebPushClient', () => {
  const baseConfig = {
    vapidSubject: 'mailto:admin@superhero.com',
    webPushFetchTimeoutMs: 50,
  } as any;

  const configuredConfig = {
    ...baseConfig,
    vapidPublicKey:
      'BH48--skSmKK5wcCFq33bvGVSBat96xZIOeP6XOMsYe83K1OVEzmNflW8NC55a1s15wpQFBULNxLuhCMv4sMLtI',
    vapidPrivateKey: 'QxpqtcLM6kZtan5RGBSPcneWpitBBPrisplNL2TAf_Y',
  };

  const subscription = {
    endpoint: 'https://push.example/abc',
    keys: { p256dh: 'p', auth: 'a' },
  } as any;

  describe('isConfigured', () => {
    it('is false when VAPID keys are absent (channel stays dark)', () => {
      const client = new WebPushClient({ ...baseConfig });
      expect(client.isConfigured()).toBe(false);
    });

    it('is true when a valid VAPID keypair is present', () => {
      const client = new WebPushClient({
        ...baseConfig,
        vapidPublicKey:
          'BH48--skSmKK5wcCFq33bvGVSBat96xZIOeP6XOMsYe83K1OVEzmNflW8NC55a1s15wpQFBULNxLuhCMv4sMLtI',
        vapidPrivateKey: 'QxpqtcLM6kZtan5RGBSPcneWpitBBPrisplNL2TAf_Y',
      });
      expect(client.isConfigured()).toBe(true);
    });

    it('stays disabled (not crashing) on a malformed VAPID key', () => {
      const client = new WebPushClient({
        ...baseConfig,
        vapidPublicKey: 'not-a-real-key',
        vapidPrivateKey: 'nope',
      });
      expect(client.isConfigured()).toBe(false);
    });
  });

  describe('send', () => {
    let sendSpy: jest.SpyInstance;

    beforeEach(() => {
      sendSpy = jest.spyOn(webpush, 'sendNotification');
    });

    afterEach(() => {
      sendSpy.mockRestore();
    });

    it('passes web-push a NATIVE socket timeout, not a Promise.race', async () => {
      // Regression: a bare Promise.race(sendNotification(...), timer) only
      // stops OUR side from waiting — the original HTTP call keeps running in
      // the background, and a merely-slow (not actually down) push service
      // could still deliver it after we've already told Bull to retry,
      // duplicating the OS notification. web-push's own `timeout` option
      // instead has the library itself destroy the underlying request on
      // expiry, so a "timed out" send is genuinely dead, never delivered late.
      sendSpy.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
      const client = new WebPushClient(configuredConfig);

      await client.send(subscription, { title: 't', body: 'b' });

      expect(sendSpy).toHaveBeenCalledWith(
        subscription,
        JSON.stringify({ title: 't', body: 'b' }),
        expect.objectContaining({ timeout: 50 }),
      );
    });

    it('propagates a rejection from sendNotification (e.g. a genuine socket timeout)', async () => {
      sendSpy.mockRejectedValue(new Error('Socket timeout'));
      const client = new WebPushClient(configuredConfig);

      await expect(
        client.send(subscription, { title: 't', body: 'b' }),
      ).rejects.toThrow('Socket timeout');
    });
  });

  describe('classify', () => {
    const err = (statusCode: number) =>
      new WebPushError('boom', statusCode, {} as any, '', '');

    it('treats 404/410 as expired (prune)', () => {
      expect(WebPushClient.classify(err(404))).toBe('expired');
      expect(WebPushClient.classify(err(410))).toBe('expired');
    });

    it('treats 429 and 5xx as retryable', () => {
      expect(WebPushClient.classify(err(429))).toBe('retryable');
      expect(WebPushClient.classify(err(500))).toBe('retryable');
      expect(WebPushClient.classify(err(503))).toBe('retryable');
    });

    it('treats a non-WebPushError (timeout/network) as retryable', () => {
      expect(WebPushClient.classify(new Error('timed out'))).toBe('retryable');
    });

    it('treats 400/403/413 as permanent (drop)', () => {
      expect(WebPushClient.classify(err(400))).toBe('permanent');
      expect(WebPushClient.classify(err(403))).toBe('permanent');
      expect(WebPushClient.classify(err(413))).toBe('permanent');
    });
  });
});
