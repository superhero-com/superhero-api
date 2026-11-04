import {
  DEFAULT_PUSH_SERVICE_HOSTS,
  parsePushEndpoint,
  pushServiceHosts,
} from './push-endpoint';

describe('parsePushEndpoint', () => {
  const hosts = DEFAULT_PUSH_SERVICE_HOSTS;

  it.each([
    'https://fcm.googleapis.com/fcm/send/dGVzdA:APA91bH',
    'https://fcm.googleapis.com/wp/dGVzdA',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
    'https://web.push.apple.com/QGuQyavXutnMH',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2b',
    'https://FCM.GoogleApis.com/fcm/send/x',
    'https://fcm.googleapis.com:443/fcm/send/x',
  ])('accepts a browser push endpoint: %s', (endpoint) => {
    expect(parsePushEndpoint(endpoint, hosts)).toBeInstanceOf(URL);
  });

  it.each([
    'https://127.0.0.1/push',
    'https://10.0.0.5:8443/admin?x=1',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/push',
    'https://redis.internal/',
    'https://localhost/',
    'http://fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com:8443/fcm/send/x',
    'https://user:pass@fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com@evil.com/',
    'https://fcm.googleapis.com.evil.com/',
    'https://xfcm.googleapis.com/',
    'https://evil.com/fcm.googleapis.com',
    'not a url',
  ])('rejects %s', (endpoint) => {
    expect(parsePushEndpoint(endpoint, hosts)).toBeNull();
  });

  it('returns the URL it validated, so the sender connects to that host', () => {
    expect(
      parsePushEndpoint('https://fcm.googleapis.com/fcm/send/x?y=1', hosts)
        ?.href,
    ).toBe('https://fcm.googleapis.com/fcm/send/x?y=1');
  });
});

describe('pushServiceHosts', () => {
  it('falls back to the browser defaults when unset or blank', () => {
    expect(pushServiceHosts(undefined)).toEqual(DEFAULT_PUSH_SERVICE_HOSTS);
    expect(pushServiceHosts(' , ')).toEqual(DEFAULT_PUSH_SERVICE_HOSTS);
  });

  it('normalizes a configured list', () => {
    expect(pushServiceHosts(' Push.Example.COM, .other.example ')).toEqual([
      'push.example.com',
      'other.example',
    ]);
  });
});
