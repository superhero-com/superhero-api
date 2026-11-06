import { createECDH, randomBytes } from 'crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateWebPushSubscriptionDto,
  DeleteWebPushSubscriptionDto,
} from './web-push-subscription.dto';

describe('CreateWebPushSubscriptionDto', () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };

  const errorsFor = async (body: Record<string, unknown>) => {
    const dto = plainToInstance(CreateWebPushSubscriptionDto, body);
    return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  };

  // Every test starts on the built-in defaults, whatever the shell exported.
  const ambientHosts = process.env.WEB_PUSH_ALLOWED_HOSTS;
  beforeEach(() => {
    delete process.env.WEB_PUSH_ALLOWED_HOSTS;
  });
  afterAll(() => {
    if (ambientHosts !== undefined) {
      process.env.WEB_PUSH_ALLOWED_HOSTS = ambientHosts;
    }
  });

  it('accepts what a browser posts', async () => {
    expect(
      await errorsFor({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc:APA91b',
        keys,
        userAgent: 'Chrome',
      }),
    ).toEqual([]);
  });

  it.each([
    'https://10.0.0.5:8443/admin',
    'https://redis.internal/',
    'https://attacker.example/push',
    'https://fcm.googleapis.com:8443/fcm/send/x',
  ])('rejects an endpoint that is not a push service: %s', async (endpoint) => {
    const errors = await errorsFor({ endpoint, keys });
    expect(errors.map((e) => e.property)).toEqual(['endpoint']);
  });

  it('honours WEB_PUSH_ALLOWED_HOSTS', async () => {
    process.env.WEB_PUSH_ALLOWED_HOSTS = 'push.example.com';
    expect(
      await errorsFor({ endpoint: 'https://push.example.com/x', keys }),
    ).toEqual([]);
    expect(
      (await errorsFor({ endpoint: 'https://fcm.googleapis.com/x', keys }))
        .length,
    ).toBe(1);
  });

  it.each([
    [{ ...keys, p256dh: 'p' }],
    [{ ...keys, p256dh: randomBytes(64).toString('base64url') }],
    [{ ...keys, auth: randomBytes(15).toString('base64url') }],
  ])('rejects keys web-push cannot encrypt to: %j', async (badKeys) => {
    const errors = await errorsFor({
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: badKeys,
    });
    expect(errors.map((e) => e.property)).toEqual(['keys']);
  });
});

describe('DeleteWebPushSubscriptionDto', () => {
  it('still accepts an endpoint off the allowlist, so old rows can be removed', async () => {
    const dto = plainToInstance(DeleteWebPushSubscriptionDto, {
      endpoint: 'https://attacker.example/push',
    });
    expect(await validate(dto)).toEqual([]);
  });
});
