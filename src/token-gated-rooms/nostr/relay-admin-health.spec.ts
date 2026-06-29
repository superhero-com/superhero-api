import type { RelayWriter } from './relay-writer.contract';
import {
  ABUSE_VECTOR_NOTE,
  RELAY_ADMIN_PUBKEY_ENV,
  RelayAdminHealthService,
  wsUrlToHttp,
} from './relay-admin-health';

const hex = (n: number): string =>
  (n.toString(16).padStart(2, '0') + 'a'.repeat(62)).slice(0, 64);

const BOT = hex(0);
const OTHER = hex(9);

function makeConfig(): any {
  return { nostrRelayUrl: 'ws://localhost:8080' };
}

function makeRelay(
  pubkey = BOT,
  publishOk = true,
): jest.Mocked<Pick<RelayWriter, 'pubkey' | 'publish'>> {
  return {
    pubkey,
    publish: jest
      .fn()
      .mockResolvedValue({ ok: publishOk, id: 'evt', reason: 'rejected' }),
  } as any;
}

function build(
  relay = makeRelay(),
  config = makeConfig(),
): RelayAdminHealthService {
  return new RelayAdminHealthService(config, relay as unknown as RelayWriter);
}

/** Stub global fetch to return a NIP-11 doc with the given admin pubkey. */
function stubNip11(pubkey: string | undefined, ok = true): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ pubkey, supported_nips: [1, 11, 29, 42] }),
  }) as any;
}

describe('wsUrlToHttp', () => {
  it('ws→http, wss→https, http(s) passthrough', () => {
    expect(wsUrlToHttp('ws://r:8080')).toBe('http://r:8080');
    expect(wsUrlToHttp('wss://r')).toBe('https://r');
    expect(wsUrlToHttp('http://r')).toBe('http://r');
    expect(wsUrlToHttp('https://r')).toBe('https://r');
  });
  it('blank/garbage → undefined', () => {
    expect(wsUrlToHttp('')).toBeUndefined();
    expect(wsUrlToHttp(undefined)).toBeUndefined();
    expect(wsUrlToHttp('not-a-url')).toBeUndefined();
  });
});

describe('RelayAdminHealthService.verify', () => {
  const originalFetch = global.fetch;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[RELAY_ADMIN_PUBKEY_ENV];
    delete process.env[RELAY_ADMIN_PUBKEY_ENV];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (savedEnv === undefined) {
      delete process.env[RELAY_ADMIN_PUBKEY_ENV];
    } else {
      process.env[RELAY_ADMIN_PUBKEY_ENV] = savedEnv;
    }
    jest.restoreAllMocks();
  });

  it('passes when the bot pubkey == the NIP-11 relay admin pubkey and publish OKs', async () => {
    stubNip11(BOT);
    const relay = makeRelay(BOT, true);
    await expect(build(relay).verify()).resolves.toBeUndefined();
    // publish probe (create) ran.
    expect(relay.publish).toHaveBeenCalled();
  });

  it('FAILS FAST when the bot key is NOT the relay admin (mismatch)', async () => {
    stubNip11(OTHER);
    await expect(build(makeRelay(BOT, true)).verify()).rejects.toThrow(
      /NOT the relay admin/i,
    );
  });

  it('the failure log names the abuse vector', async () => {
    stubNip11(OTHER);
    await expect(build(makeRelay(BOT, true)).verify()).rejects.toThrow(
      ABUSE_VECTOR_NOTE,
    );
  });

  it('falls back to TG_RELAY_ADMIN_PUBKEY when NIP-11 omits pubkey', async () => {
    stubNip11(undefined); // NIP-11 served no pubkey
    process.env[RELAY_ADMIN_PUBKEY_ENV] = BOT;
    await expect(build(makeRelay(BOT, true)).verify()).resolves.toBeUndefined();
  });

  it('fails when neither NIP-11 nor the env fallback yields an admin pubkey', async () => {
    stubNip11(undefined);
    await expect(build(makeRelay(BOT, true)).verify()).rejects.toThrow(
      /could not determine the relay admin pubkey/i,
    );
  });

  it('fails when the publish probe is rejected (not already-exists)', async () => {
    stubNip11(BOT);
    const relay = makeRelay(BOT, false);
    relay.publish.mockResolvedValue({
      ok: false,
      id: 'evt',
      reason: 'some relay reject',
    });
    await expect(build(relay).verify()).rejects.toThrow(
      /publish probe failed/i,
    );
  });

  it('treats an "already exists" publish reject as a benign success', async () => {
    stubNip11(BOT);
    const relay = makeRelay(BOT, false);
    relay.publish.mockResolvedValueOnce({
      ok: false,
      id: 'evt',
      reason: 'Group already exists',
    });
    // cleanup 9008 publish (second call) — any resolution is fine.
    relay.publish.mockResolvedValueOnce({ ok: true, id: 'evt2' });
    await expect(build(relay).verify()).resolves.toBeUndefined();
  });

  it('tolerates a NIP-11 fetch failure and uses the env fallback', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as any;
    process.env[RELAY_ADMIN_PUBKEY_ENV] = BOT;
    await expect(build(makeRelay(BOT, true)).verify()).resolves.toBeUndefined();
  });
});
