import { JOURNEY_EVENTS, JOURNEY_FUNNELS } from './journey.constants';
import { parseJourneyPayload, sanitizeJourneyPage } from './journey-payload';

const ANON = '3f2b8c4e-9a1d-4c6e-8b7a-1d2e3f4a5b6c';
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

function body(events: unknown[], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ v: 1, a: ANON, e: events, ...overrides });
}

describe('journey payload parsing', () => {
  it('accepts the beacon body as raw text and returns only the stored fields', () => {
    const rows = parseJourneyPayload(
      body([
        { n: 'profile_view', p: '/users/:address', t: NOW - 1000, x: 'extra' },
      ]),
      NOW,
    );
    expect(rows).toEqual([
      {
        anon_id: ANON,
        event: 'profile_view',
        page: '/users/:address',
        occurred_at: new Date(NOW - 1000),
      },
    ]);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'anon_id',
      'event',
      'occurred_at',
      'page',
    ]);
  });

  it('accepts an already-parsed object and a Buffer', () => {
    const object = { v: 1, a: ANON, e: [{ n: 'page_view', p: '/', t: NOW }] };
    expect(parseJourneyPayload(object, NOW)).toHaveLength(1);
    expect(
      parseJourneyPayload(Buffer.from(JSON.stringify(object)), NOW),
    ).toHaveLength(1);
  });

  it.each([
    ['not json', '{"v":1,'],
    ['empty string', ''],
    ['array', '[]'],
    ['null', 'null'],
    ['wrong version', body([{ n: 'page_view', p: '/', t: NOW }], { v: 2 })],
    [
      'missing id',
      body([{ n: 'page_view', p: '/', t: NOW }], { a: undefined }),
    ],
    [
      'non-uuid id',
      body([{ n: 'page_view', p: '/', t: NOW }], { a: 'ak_2abc' }),
    ],
    [
      'uuid v1 id',
      body([{ n: 'page_view', p: '/', t: NOW }], {
        a: 'a8098c1a-f86e-11da-bd1a-00112444be1e',
      }),
    ],
    ['events not a list', JSON.stringify({ v: 1, a: ANON, e: {} })],
  ])('drops a malformed body (%s) without throwing', (_name, input) => {
    expect(parseJourneyPayload(input, NOW)).toEqual([]);
  });

  it('drops events outside the allowlist and keeps the rest', () => {
    const rows = parseJourneyPayload(
      body([
        { n: 'page_view', p: '/', t: NOW },
        { n: 'wallet_address_seen', p: '/', t: NOW },
        { n: 'PAGE_VIEW', p: '/', t: NOW },
        { n: 42, p: '/', t: NOW },
        null,
        'page_view',
      ]),
      NOW,
    );
    expect(rows.map((r) => r.event)).toEqual(['page_view']);
  });

  it('caps a request at 50 events', () => {
    const events = Array.from({ length: 80 }, (_, i) => ({
      n: 'page_view',
      p: '/',
      t: NOW - i,
    }));
    expect(parseJourneyPayload(body(events), NOW)).toHaveLength(50);
  });

  it('drops timestamps older than 24h or more than 5 minutes ahead, and non-numbers', () => {
    const rows = parseJourneyPayload(
      body([
        { n: 'page_view', p: '/a', t: NOW - 24 * 3600 * 1000 - 1 },
        { n: 'page_view', p: '/b', t: NOW - 24 * 3600 * 1000 },
        { n: 'page_view', p: '/c', t: NOW + 5 * 60 * 1000 },
        { n: 'page_view', p: '/d', t: NOW + 5 * 60 * 1000 + 1 },
        { n: 'page_view', p: '/e', t: String(NOW) },
        { n: 'page_view', p: '/f', t: Number.NaN },
        { n: 'page_view', p: '/g' },
      ]),
      NOW,
    );
    expect(rows.map((r) => r.page)).toEqual(['/b', '/c']);
  });

  it('lower-cases the anonymous id so one browser is one id', () => {
    const rows = parseJourneyPayload(
      body([{ n: 'page_view', p: '/', t: NOW }], { a: ANON.toUpperCase() }),
      NOW,
    );
    expect(rows[0].anon_id).toBe(ANON);
  });

  it('exports every funnel step from the allowlist', () => {
    for (const funnel of JOURNEY_FUNNELS) {
      for (const step of funnel.steps) {
        expect(JOURNEY_EVENTS).toContain(step.event);
      }
    }
  });
});

describe('journey page sanitising', () => {
  it.each([
    '/',
    '/users/:address',
    '/trends/tokens/:tokenName',
    '/defi/swap',
    '(other)',
    '/a.b-c_d/(x)',
  ])('keeps route pattern %s', (page) => {
    expect(sanitizeJourneyPage(page)).toBe(page);
  });

  it.each([
    [
      'an account address',
      '/users/ak_2swhLkgBPeeADxVTAVCJnZLY5NZtCFiM93JxsEaMuC59euuFRQ',
    ],
    ['a tx hash', '/tx/th_2Fm7uuLu1RGTkMNWqqWWNYkNyZakQZCUZVbuqAGYJmnCtcSkMH'],
    [
      'a contract id',
      '/c/ct_2AfnEfCSZCTEkxL5Yoi4Yfq6fF7YapHRaFKDJK3THMXMBspp5z',
    ],
    ['a name hash', '/n/nm_2bJvQzKR7KLA9kSbh3aSBiwjdrWMN4bRmRqq1Gc87k9jcmkXjF'],
    [
      'an oracle id',
      '/o/ok_2bJvQzKR7KLA9kSbh3aSBiwjdrWMN4bRmRqq1Gc87k9jcmkXjF',
    ],
    ['a 0x hex string', '/eth/0x52908400098527886E0F7030069857D2E4169EE7'],
    ['a query string', '/users?address=x'],
    ['a hash fragment', '/users#me'],
    ['no leading slash', 'users/:address'],
    ['a full URL', 'https://superhero.com/users/x'],
    ['spaces', '/users/john doe'],
    ['too long', '/' + 'a'.repeat(96)],
    ['a number', 12],
    ['missing', undefined],
  ])('rewrites %s to (other)', (_name, page) => {
    expect(sanitizeJourneyPage(page)).toBe('(other)');
  });

  it('keeps a 96-character pattern', () => {
    const page = '/' + 'a'.repeat(95);
    expect(sanitizeJourneyPage(page)).toBe(page);
  });

  it('rewrites inside parsed rows too', () => {
    const rows = parseJourneyPayload(
      body([
        {
          n: 'profile_view',
          p: '/users/ak_2swhLkgBPeeADxVTAVCJnZLY5NZtCFiM93JxsEaMuC59euuFRQ',
          t: NOW,
        },
      ]),
      NOW,
    );
    expect(rows[0].page).toBe('(other)');
  });
});
