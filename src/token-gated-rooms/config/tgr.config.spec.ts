import tgrConfig, { isRelayConfigured } from './tgr.config';

describe('isRelayConfigured', () => {
  // Worker mode removed (deworker-plan.md): the relay-actuator duties self-enable
  // iff BOTH TG_RELAY_URL and TG_BOT_NSEC are present (non-blank).
  it('true when both relay url + bot nsec are present (env map form)', () => {
    expect(
      isRelayConfigured({
        TG_RELAY_URL: 'ws://relay',
        TG_BOT_NSEC: 'nsec1abc',
      }),
    ).toBe(true);
  });

  it('true when both are present (typed config form)', () => {
    expect(
      isRelayConfigured({
        nostrRelayUrl: 'ws://relay',
        nostrBotNsec: 'nsec1abc',
      }),
    ).toBe(true);
  });

  it('false when the relay url is missing', () => {
    expect(isRelayConfigured({ TG_BOT_NSEC: 'nsec1abc' })).toBe(false);
    expect(
      isRelayConfigured({ nostrRelayUrl: '', nostrBotNsec: 'nsec1abc' }),
    ).toBe(false);
  });

  it('false when the bot nsec is missing', () => {
    expect(isRelayConfigured({ TG_RELAY_URL: 'ws://relay' })).toBe(false);
    expect(
      isRelayConfigured({ nostrRelayUrl: 'ws://relay', nostrBotNsec: '   ' }),
    ).toBe(false);
  });

  it('false when both are blank/absent', () => {
    expect(isRelayConfigured({})).toBe(false);
    expect(isRelayConfigured({ TG_RELAY_URL: '  ', TG_BOT_NSEC: '' })).toBe(
      false,
    );
  });
});

describe('tgrConfig defaults', () => {
  const TGR_KEYS = [
    'TG_RELAY_URL',
    'TG_BOT_NSEC',
    'TG_ROOM_ADMINS',
    'NOSTR_LINK_PROVIDER',
    'TG_GROUP_ID_PREFIX',
    'TG_BACKFILL_BATCH_SIZE',
    'TG_ROOM_PROVISION_BATCH',
    'TG_PUBLISH_CONCURRENCY',
    'TG_PUBLISH_RATE_PER_SEC',
    'TG_PUBLISH_ACK_TIMEOUT_MS',
    'TG_PUBLISH_MAX_RETRIES',
    'TG_PUBLISH_BACKOFF_CAP',
    'TG_RELAY_HEALTH_PAUSE_SEC',
    'TG_REORG_CONFIRMATION_DEPTH_BLOCKS',
    'TG_RECONCILE_BATCH_SIZE',
    'TG_RECONCILE_INTERVAL',
    'TG_COMMUNITY_TOKEN_REFRESH',
    'TG_MSG_COALESCE_WINDOW_SEC',
    'TG_MSG_RATE_CAP',
    'TG_ROOM_NOTIFY_DEPTH_BREAK',
    'TG_SUBSCRIBER_SHARDS',
  ];

  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of TGR_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of TGR_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('resolves every §18 var to its documented default when env is unset', () => {
    const cfg = tgrConfig();
    expect(cfg.nostrRelayUrl).toBeUndefined();
    expect(cfg.nostrBotNsec).toBeUndefined();
    expect(cfg.nostrRoomAdmins).toEqual([]);
    expect(cfg.nostrLinkProvider).toBe('nostr');
    expect(cfg.nostrGroupIdPrefix).toBe('sh');
    expect(cfg.backfillBatchSize).toBe(100);
    expect(cfg.backfillPageDelayMs).toBe(1000);
    expect(cfg.roomProvisionBatchSize).toBe(100);
    expect(cfg.publishConcurrency).toBe(2);
    expect(cfg.publishRatePerSec).toBe(100);
    expect(cfg.publishAckTimeoutMs).toBe(5000);
    expect(cfg.publishMaxRetries).toBe(5);
    expect(cfg.publishBackoffCapMs).toBe(5 * 60 * 1000);
    expect(cfg.relayHealthPauseSec).toBe(5);
    expect(cfg.reorgConfirmationDepthBlocks).toBe(10);
    expect(cfg.reconcileBatchSize).toBe(500);
    expect(cfg.reconcileIntervalSec).toBe(10 * 60);
    expect(cfg.communityTokenRefreshSec).toBe(5 * 60);
    expect(cfg.msgCoalesceWindowSec).toBe(60);
    expect(cfg.roomNotifyDepthBreak).toBe(10000);
    expect(cfg.subscriberShards).toBe(1);
    expect(cfg.queuePrefixes).toEqual({ main: 'main', worker: 'worker' });
  });

  it('rejects garbage numeric knobs and falls back to default', () => {
    process.env.TG_BACKFILL_BATCH_SIZE = 'not-a-number';
    process.env.TG_PUBLISH_CONCURRENCY = '';
    process.env.TG_PUBLISH_ACK_TIMEOUT_MS = 'abc';
    process.env.TG_SUBSCRIBER_SHARDS = '-3'; // below min
    const cfg = tgrConfig();
    expect(cfg.backfillBatchSize).toBe(100);
    expect(cfg.publishConcurrency).toBe(2);
    expect(cfg.publishAckTimeoutMs).toBe(5000);
    expect(cfg.subscriberShards).toBe(1);
  });

  it('parses valid numeric overrides', () => {
    process.env.TG_BACKFILL_BATCH_SIZE = '50';
    process.env.TG_PUBLISH_RATE_PER_SEC = '250';
    process.env.TG_ROOM_PROVISION_BATCH = '80';
    const cfg = tgrConfig();
    expect(cfg.backfillBatchSize).toBe(50);
    expect(cfg.publishRatePerSec).toBe(250);
    expect(cfg.roomProvisionBatchSize).toBe(80);
  });

  it('hard-caps room-batch knobs at 100 → an over-cap override falls back to default', () => {
    process.env.TG_BACKFILL_BATCH_SIZE = '500'; // above max 100 → default
    expect(tgrConfig().backfillBatchSize).toBe(100);
    process.env.TG_ROOM_PROVISION_BATCH = '5000'; // above max 100 → default
    expect(tgrConfig().roomProvisionBatchSize).toBe(100);
    process.env.TG_ROOM_PROVISION_BATCH = '0'; // below min → default
    expect(tgrConfig().roomProvisionBatchSize).toBe(100);
    process.env.TG_ROOM_PROVISION_BATCH = 'garbage';
    expect(tgrConfig().roomProvisionBatchSize).toBe(100);
  });

  it('parses TG_ROOM_ADMINS comma-separated into a trimmed array', () => {
    process.env.TG_ROOM_ADMINS = ' npub1aaa , npub1bbb ,, npub1ccc ';
    const cfg = tgrConfig();
    expect(cfg.nostrRoomAdmins).toEqual(['npub1aaa', 'npub1bbb', 'npub1ccc']);
  });

  it('parses an empty TG_ROOM_ADMINS into []', () => {
    process.env.TG_ROOM_ADMINS = '';
    expect(tgrConfig().nostrRoomAdmins).toEqual([]);
  });

  it('parses duration knobs (5m / 10m) into the documented units', () => {
    process.env.TG_RECONCILE_INTERVAL = '15m';
    process.env.TG_COMMUNITY_TOKEN_REFRESH = '90s';
    process.env.TG_PUBLISH_BACKOFF_CAP = '2m';
    const cfg = tgrConfig();
    expect(cfg.reconcileIntervalSec).toBe(15 * 60);
    expect(cfg.communityTokenRefreshSec).toBe(90);
    expect(cfg.publishBackoffCapMs).toBe(2 * 60 * 1000);
  });

  it('falls back on garbage duration values', () => {
    process.env.TG_RECONCILE_INTERVAL = 'soon';
    expect(tgrConfig().reconcileIntervalSec).toBe(10 * 60);
  });

  it('isRelayConfigured reads the resolved typed config', () => {
    process.env.TG_RELAY_URL = 'ws://relay';
    process.env.TG_BOT_NSEC = 'nsec1abc';
    expect(isRelayConfigured(tgrConfig())).toBe(true);
    delete process.env.TG_BOT_NSEC;
    expect(isRelayConfigured(tgrConfig())).toBe(false);
  });
});
