import { createECDH, randomBytes } from 'crypto';
import http from 'http';
import https from 'https';
import { AddressInfo } from 'net';
import webpush, { WebPushError } from 'web-push';
import { DEFAULT_PUSH_SERVICE_HOSTS } from './push-endpoint';
import {
  MAX_PUSH_RESPONSE_BYTES,
  UnsendablePushError,
  vapidKeysMatch,
  WebPushClient,
} from './web-push.client';

describe('WebPushClient', () => {
  const baseConfig = {
    vapidSubject: 'mailto:admin@superhero.com',
    webPushFetchTimeoutMs: 2_000,
    webPushAllowedHosts: DEFAULT_PUSH_SERVICE_HOSTS,
  } as any;

  const configuredConfig = {
    ...baseConfig,
    vapidPublicKey:
      'BH48--skSmKK5wcCFq33bvGVSBat96xZIOeP6XOMsYe83K1OVEzmNflW8NC55a1s15wpQFBULNxLuhCMv4sMLtI',
    vapidPrivateKey: 'QxpqtcLM6kZtan5RGBSPcneWpitBBPrisplNL2TAf_Y',
  };

  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc?x=1',
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
  const payload = { title: 't', body: 'b' };

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

    it("stays disabled when the public key is not the private key's pair", () => {
      // Format-valid but mismatched: setVapidDetails accepts it, every send
      // would then 403 and be dropped as permanent. Must be refused at boot.
      const other = webpush.generateVAPIDKeys();
      const client = new WebPushClient({
        ...baseConfig,
        vapidPublicKey: other.publicKey,
        vapidPrivateKey: configuredConfig.vapidPrivateKey,
      });
      expect(client.isConfigured()).toBe(false);
    });

    it('accepts a freshly generated keypair', () => {
      const pair = webpush.generateVAPIDKeys();
      const client = new WebPushClient({
        ...baseConfig,
        vapidPublicKey: pair.publicKey,
        vapidPrivateKey: pair.privateKey,
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
    let server: http.Server;
    let handler: http.RequestListener;
    let requestSpy: jest.SpyInstance;
    let hungUp: () => void;
    let clientHungUp: Promise<void>;

    const client = (timeoutMs = 2_000) =>
      new WebPushClient({
        ...configuredConfig,
        webPushFetchTimeoutMs: timeoutMs,
      });

    // Writes until the client hangs up; the test hangs if the client never does.
    const endlessReply =
      (status: number): http.RequestListener =>
      (req, res) => {
        req.resume();
        res.on('close', hungUp);
        res.writeHead(status);
        const chunk = Buffer.alloc(16 * 1024, 'a');
        const pump = (): void => {
          while (!res.destroyed) {
            if (!res.write(chunk)) {
              res.once('drain', pump);
              return;
            }
          }
        };
        pump();
      };

    beforeEach(async () => {
      clientHungUp = new Promise((resolve) => (hungUp = resolve));
      server = http.createServer((req, res) => handler(req, res));
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const { port } = server.address() as AddressInfo;
      // Same Node request/response machinery minus TLS: point the client's
      // https.request at the local plain-HTTP server.
      requestSpy = jest.spyOn(https, 'request').mockImplementation(((
        url: URL,
        options: any,
        callback: any,
      ) =>
        http.request(
          {
            host: '127.0.0.1',
            port,
            path: url.pathname + url.search,
            method: options.method,
            headers: options.headers,
          },
          callback,
        )) as any);
    });

    afterEach(async () => {
      requestSpy.mockRestore();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    it('sends the encrypted VAPID request web-push builds and resolves on 201', async () => {
      let seen: { req: http.IncomingMessage; bytes: number } | undefined;
      handler = (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          seen = { req, bytes: Buffer.concat(chunks).length };
          res.writeHead(201).end();
        });
      };

      await expect(client().send(subscription, payload)).resolves.toBe(
        undefined,
      );

      // The connection goes to the endpoint that passed the allowlist.
      expect((requestSpy.mock.calls[0][0] as URL).href).toBe(
        subscription.endpoint,
      );
      expect(seen?.req.method).toBe('POST');
      expect(seen?.req.url).toBe('/fcm/send/abc?x=1');
      expect(seen?.req.headers).toEqual(
        expect.objectContaining({
          ttl: '86400',
          'content-encoding': 'aes128gcm',
          authorization: expect.stringMatching(/^vapid t=/),
        }),
      );
      expect(seen?.bytes).toBeGreaterThan(0);
      expect(seen?.bytes).toBe(Number(seen?.req.headers['content-length']));
    });

    it('rejects a non-2xx reply as a WebPushError with its status and body', async () => {
      handler = (req, res) => {
        req.resume();
        res.writeHead(410).end('gone');
      };

      const error = await client()
        .send(subscription, payload)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WebPushError);
      expect(error).toEqual(
        expect.objectContaining({ statusCode: 410, body: 'gone' }),
      );
      expect(WebPushClient.classify(error)).toBe('expired');
    });

    it('stops reading an endless reply and settles on its 2xx status', async () => {
      handler = endlessReply(201);

      await expect(client().send(subscription, payload)).resolves.toBe(
        undefined,
      );
      await clientHungUp;
    });

    it('keeps at most MAX_PUSH_RESPONSE_BYTES of an endless error reply', async () => {
      handler = endlessReply(500);

      const error = await client()
        .send(subscription, payload)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WebPushError);
      expect((error as WebPushError).statusCode).toBe(500);
      expect((error as WebPushError).body).toHaveLength(
        MAX_PUSH_RESPONSE_BYTES,
      );
      await clientHungUp;
    });

    it('gives up at the deadline even while bytes keep trickling in', async () => {
      // An idle timeout never fires here: a byte arrives every 20ms.
      let drip: NodeJS.Timeout | undefined;
      handler = (req, res) => {
        req.resume();
        res.on('close', () => {
          clearInterval(drip);
          hungUp();
        });
        res.writeHead(201);
        drip = setInterval(() => res.write('a'), 20);
      };

      const started = Date.now();
      await expect(client(200).send(subscription, payload)).rejects.toThrow(
        'Web push send timed out after 200ms',
      );
      expect(Date.now() - started).toBeLessThan(2_000);
      await clientHungUp;
    });

    it('gives up at the deadline when no reply ever starts', async () => {
      handler = (req, res) => {
        req.resume();
        res.on('close', hungUp);
      };

      await expect(client(200).send(subscription, payload)).rejects.toThrow(
        'Web push send timed out after 200ms',
      );
      await clientHungUp;
    });

    it('rejects a connection dropped before any reply as retryable', async () => {
      handler = (req) => req.socket.destroy();

      const error = await client()
        .send(subscription, payload)
        .catch((e: unknown) => e);

      // Node builds this error outside jest's realm, so toBeInstanceOf(Error)
      // would fail; the message check still fails if send() resolved.
      expect(error).toHaveProperty('message');
      expect(error).not.toBeInstanceOf(WebPushError);
      expect(WebPushClient.classify(error)).toBe('retryable');
    });

    it('refuses an endpoint off the push-service allowlist without connecting', async () => {
      const error = await client()
        .send({ ...subscription, endpoint: 'https://10.0.0.5/push' }, payload)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnsendablePushError);
      expect(WebPushClient.classify(error)).toBe('permanent');
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it('drops keys web-push cannot encrypt to instead of retrying them', async () => {
      // Right length for the DTO, but not a point on P-256.
      const offCurve = Buffer.alloc(65);
      offCurve[0] = 0x04;

      const error = await client()
        .send(
          {
            ...subscription,
            keys: {
              ...subscription.keys,
              p256dh: offCurve.toString('base64url'),
            },
          },
          payload,
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnsendablePushError);
      expect(WebPushClient.classify(error)).toBe('permanent');
      expect(requestSpy).not.toHaveBeenCalled();
    });
  });

  describe('acceptsEndpoint', () => {
    it('applies the configured push-service allowlist', () => {
      const client = new WebPushClient(configuredConfig);
      expect(client.acceptsEndpoint(subscription.endpoint)).toBe(true);
      expect(client.acceptsEndpoint('https://redis.internal/')).toBe(false);
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

describe('vapidKeysMatch', () => {
  it('matches a generated pair and rejects a crossed pair', () => {
    const a = webpush.generateVAPIDKeys();
    const b = webpush.generateVAPIDKeys();
    expect(vapidKeysMatch(a.publicKey, a.privateKey)).toBe(true);
    expect(vapidKeysMatch(b.publicKey, a.privateKey)).toBe(false);
  });

  it('is false (not throwing) on garbage input', () => {
    expect(vapidKeysMatch('not-a-key', 'nope')).toBe(false);
    expect(vapidKeysMatch('', '')).toBe(false);
  });
});
