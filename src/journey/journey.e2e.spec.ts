/**
 * The journey analytics against a REAL PostgreSQL and a REAL HTTP server.
 *
 * Covers what a mocked test cannot: the migration SQL, the funnel and page
 * flow statements on fixed fixtures, the raw-body ingest path (text/plain
 * beacons must not be 400'd by the app-wide parsers), the always-204 contract,
 * the operator login on every dashboard route, route ordering against a
 * catch-all `/analytics/:x` route, and whether the dashboard template renders.
 */
import {
  Controller,
  Get,
  INestApplication,
  Param,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { readFileSync } from 'fs';
import hbs from 'hbs';
import { join } from 'path';
import request from 'supertest';
import { DataSource } from 'typeorm';

import {
  findPostgresBinDir,
  startPostgres,
  PostgresHandle,
} from '@/test/reward-e2e/postgres';
import { AppModule } from '@/app.module';
import { AnalyticsModule } from '@/analytics/analytics.module';
import { AffiliationDashboardAdmin } from '@/affiliation/entities/affiliation-dashboard-admin.entity';
import { AffiliationDashboardSession } from '@/affiliation/entities/affiliation-dashboard-session.entity';
import { AffiliationDashboardAuthService } from '@/affiliation/services/affiliation-dashboard-auth.service';
import { AffiliationAnalyticsGuard } from '@/affiliation/guards/affiliation-analytics.guard';
import { AffiliationDashboardAuth1718900000034 } from '@/migrations/1718900000034-AffiliationDashboardAuth';
import { JourneyEvents1718900000040 } from '@/migrations/1718900000040-JourneyEvents';
import { JourneyEvent } from './entities/journey-event.entity';
import {
  JOURNEY_INGEST_PATH,
  journeyIngestBodyHandlers,
} from './journey-body-parser';
import { JourneyIngestBuffer } from './journey-ingest.buffer';
import { JourneyQueryService } from './journey-query.service';
import { resolveJourneyRange } from './journey-range';
import { JourneyRetentionService } from './journey-retention.service';
import { JOURNEY_FUNNELS } from './journey.constants';
import {
  JourneyDashboardController,
  JourneyIngestController,
} from './journey.controller';
import { JourneyModule } from './journey.module';

const binDir = findPostgresBinDir();
const describeWithDb = binDir ? describe : describe.skip;

/** Stands in for any future `/analytics/:something` route. */
@Controller('analytics')
class CatchAllAnalyticsController {
  @Get(':id/:sub')
  getAny(@Param('id') id: string) {
    return { caughtBy: 'catch-all', id };
  }

  @Post(':id/:sub')
  postAny() {
    return { caughtBy: 'catch-all' };
  }
}

const NAVIGATE = { 'sec-fetch-mode': 'navigate', accept: 'text/html' };
const FETCH = { 'sec-fetch-mode': 'cors', accept: 'application/json' };

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

describe('journey route order', () => {
  it('registers JourneyModule before AnalyticsModule in AppModule', () => {
    const imports: unknown[] = Reflect.getMetadata('imports', AppModule);
    const journey = imports.indexOf(JourneyModule);
    const analytics = imports.indexOf(AnalyticsModule);
    expect(journey).toBeGreaterThanOrEqual(0);
    expect(journey).toBeLessThan(analytics);
  });

  it('guards the whole dashboard controller and leaves ingest public', () => {
    expect(
      Reflect.getMetadata('__guards__', JourneyDashboardController),
    ).toContain(AffiliationAnalyticsGuard);
    expect(
      Reflect.getMetadata('__guards__', JourneyIngestController),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        '__guards__',
        JourneyIngestController.prototype.ingest,
      ),
    ).toBeUndefined();
  });
});

describeWithDb('journey analytics (real DB + HTTP)', () => {
  let pg: PostgresHandle | null = null;
  let ds: DataSource;
  let app: INestApplication;
  let buffer: JourneyIngestBuffer;
  let queries: JourneyQueryService;
  let auth: AffiliationDashboardAuthService;

  beforeAll(async () => {
    pg = await startPostgres(binDir as string);
    ds = new DataSource({
      type: 'postgres',
      url: pg.url,
      entities: [
        JourneyEvent,
        AffiliationDashboardAdmin,
        AffiliationDashboardSession,
      ],
      migrations: [
        AffiliationDashboardAuth1718900000034,
        JourneyEvents1718900000040,
      ],
      synchronize: false,
    });
    await ds.initialize();
    await ds.runMigrations();

    const moduleRef = await Test.createTestingModule({
      controllers: [
        JourneyIngestController,
        JourneyDashboardController,
        CatchAllAnalyticsController,
      ],
      providers: [
        JourneyIngestBuffer,
        JourneyQueryService,
        JourneyRetentionService,
        AffiliationDashboardAuthService,
        { provide: getDataSourceToken(), useValue: ds },
        {
          provide: getRepositoryToken(JourneyEvent),
          useValue: ds.getRepository(JourneyEvent),
        },
        {
          provide: getRepositoryToken(AffiliationDashboardAdmin),
          useValue: ds.getRepository(AffiliationDashboardAdmin),
        },
        {
          provide: getRepositoryToken(AffiliationDashboardSession),
          useValue: ds.getRepository(AffiliationDashboardSession),
        },
      ],
    }).compile();

    buffer = moduleRef.get(JourneyIngestBuffer);
    queries = moduleRef.get(JourneyQueryService);
    auth = moduleRef.get(AffiliationDashboardAuthService);

    const nest = moduleRef.createNestApplication<NestExpressApplication>();
    // Mirror main.ts: prefix, the route-scoped raw body reader, the strict
    // global ValidationPipe, and the Handlebars layout.
    nest.setGlobalPrefix('api');
    nest.use(JOURNEY_INGEST_PATH, ...journeyIngestBodyHandlers());
    nest.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    const viewsDir = join(__dirname, '..', '..', 'views');
    nest.setBaseViewsDir(viewsDir);
    nest.setViewEngine('hbs');
    hbs.handlebars.registerPartial(
      'main-layout',
      readFileSync(join(viewsDir, 'main-layout.hbs'), 'utf8'),
    );
    hbs.handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
    app = nest;
    await app.init();
  }, 90000);

  afterAll(async () => {
    await app?.close();
    await ds?.destroy();
    pg?.stop();
  });

  beforeEach(async () => {
    // Drop anything a previous test left buffered BEFORE truncating, or a late
    // flush would write it into this test's fixtures.
    (buffer as any).rows = [];
    await buffer.flush();
    await ds.query('TRUNCATE journey_events');
  });

  const server = () => app.getHttpServer();
  const insert = async (rows: [string, string, string, string][]) => {
    await ds
      .createQueryBuilder()
      .insert()
      .into(JourneyEvent)
      .values(
        rows.map(([anon_id, event, page, at]) => ({
          anon_id,
          event,
          page,
          occurred_at: new Date(at),
        })),
      )
      .execute();
  };

  describe('migration', () => {
    it('creates exactly the agreed columns and indexes', async () => {
      const columns = await ds.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'journey_events' ORDER BY ordinal_position`,
      );
      expect(columns.map((c: any) => c.column_name)).toEqual([
        'id',
        'anon_id',
        'event',
        'page',
        'occurred_at',
        'received_at',
      ]);
      const indexes = await ds.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'journey_events' ORDER BY indexname`,
      );
      expect(indexes.map((i: any) => i.indexname)).toEqual(
        expect.arrayContaining([
          'IDX_JOURNEY_EVENTS_OCCURRED_AT',
          'IDX_JOURNEY_EVENTS_EVENT_OCCURRED_AT',
          'IDX_JOURNEY_EVENTS_ANON_OCCURRED_AT',
        ]),
      );
    });
  });

  describe('ingest (public)', () => {
    const payload = (events: unknown[], a = A) =>
      JSON.stringify({ v: 1, a, e: events });

    it('accepts a text/plain beacon, answers 204 with no body or cookie, and writes on flush', async () => {
      const now = Date.now();
      const response = await request(server())
        .post('/api/analytics/journey/events')
        .set('Content-Type', 'text/plain;charset=UTF-8')
        .send(
          payload([
            { n: 'page_view', p: '/users/:address', t: now - 2000 },
            { n: 'profile_view', p: '/users/:address', t: now - 1000 },
          ]),
        )
        .expect(204);
      expect(response.text).toBe('');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(buffer.size).toBe(2);

      await buffer.flush();
      const rows = await ds.query(
        `SELECT anon_id, event, page FROM journey_events ORDER BY occurred_at`,
      );
      expect(rows).toEqual([
        { anon_id: A, event: 'page_view', page: '/users/:address' },
        { anon_id: A, event: 'profile_view', page: '/users/:address' },
      ]);
    });

    it('accepts application/json too', async () => {
      await request(server())
        .post('/api/analytics/journey/events')
        .set('Content-Type', 'application/json')
        .send(payload([{ n: 'wallet_connected', p: '/', t: Date.now() }]))
        .expect(204);
      expect(buffer.size).toBe(1);
    });

    it.each([
      ['malformed JSON', 'text/plain', '{"v":1,"a":'],
      ['malformed JSON as application/json', 'application/json', '{"v":1,'],
      ['an unknown body type', 'application/x-www-form-urlencoded', 'a=b'],
      ['an empty body', 'text/plain', ''],
      [
        'only unknown events',
        'text/plain',
        payload([{ n: 'login_password', p: '/', t: Date.now() }]),
      ],
      [
        'a bad id',
        'text/plain',
        payload([{ n: 'page_view', p: '/', t: Date.now() }], 'not-a-uuid'),
      ],
    ])('answers 204 and buffers nothing for %s', async (_name, type, body) => {
      const response = await request(server())
        .post('/api/analytics/journey/events')
        .set('Content-Type', type)
        .send(body)
        .expect(204);
      expect(response.text).toBe('');
      expect(buffer.size).toBe(0);
    });

    it('answers 204 to a body over 16 KB and drops it', async () => {
      const big = payload([
        { n: 'page_view', p: '/' + 'a'.repeat(20000), t: Date.now() },
      ]);
      await request(server())
        .post('/api/analytics/journey/events')
        .set('Content-Type', 'text/plain')
        .send(big)
        .expect(204);
      expect(buffer.size).toBe(0);
    });

    it('rewrites a page carrying an address to (other) before it is stored', async () => {
      await request(server())
        .post('/api/analytics/journey/events')
        .set('Content-Type', 'text/plain')
        .send(
          payload([
            {
              n: 'profile_view',
              p: '/users/ak_2swhLkgBPeeADxVTAVCJnZLY5NZtCFiM93JxsEaMuC59euuFRQ',
              t: Date.now(),
            },
          ]),
        )
        .expect(204);
      await buffer.flush();
      const [row] = await ds.query(`SELECT page FROM journey_events`);
      expect(row.page).toBe('(other)');
    });

    it('is not swallowed by a catch-all /analytics/:x/:y route', async () => {
      const response = await request(server())
        .post('/api/analytics/journey/events')
        .set('Content-Type', 'text/plain')
        .send(payload([{ n: 'page_view', p: '/', t: Date.now() }]));
      expect(response.status).toBe(204);
      expect(response.text).not.toContain('catch-all');
    });
  });

  describe('funnel math', () => {
    const funnel = JOURNEY_FUNNELS.find((f) => f.id === 'onboarding');
    const range = resolveJourneyRange(
      '2026-10-01',
      '2026-10-30',
      new Date('2026-10-30T12:00:00Z'),
    );

    it('counts a browser at a step only when the step comes AFTER the previous one', async () => {
      await insert([
        // A: full path up to X connected, in order.
        [A, 'profile_view', '/users/:address', '2026-10-10T10:00:00Z'],
        [A, 'profile_edit_open', '/users/:address', '2026-10-10T10:00:10Z'],
        [A, 'claim_account_open', '/users/:address', '2026-10-10T10:01:00Z'],
        [A, 'x_connect_start', '/users/:address', '2026-10-10T10:02:00Z'],
        [A, 'x_connected', '/users/:address', '2026-10-10T10:03:00Z'],
        // B: clicked Edit BEFORE ever opening a profile -> stops at step 1.
        [B, 'profile_edit_open', '/users/:address', '2026-10-10T09:00:00Z'],
        [B, 'profile_view', '/users/:address', '2026-10-10T09:05:00Z'],
        // C: profile, Edit, then posted without claiming -> stops at step 2.
        [C, 'profile_view', '/users/:address', '2026-10-11T10:00:00Z'],
        [C, 'profile_edit_open', '/users/:address', '2026-10-11T10:00:30Z'],
        [C, 'post_created', '/', '2026-10-11T10:05:00Z'],
        // D: edit happened outside the range end -> not counted.
        [D, 'profile_view', '/users/:address', '2026-10-30T23:59:00Z'],
        [D, 'profile_edit_open', '/users/:address', '2026-10-31T00:01:00Z'],
      ]);

      const report = await queries.getFunnel(funnel, range);
      expect(report.steps.map((s) => s.count)).toEqual([4, 2, 1, 1, 1, 0, 0]);
      expect(report.steps[1]).toMatchObject({
        lostFromPrevious: 2,
        pctLostFromPrevious: 50,
        pctOfStart: 50,
        // A took 10 s, C 30 s.
        medianSecondsFromPrevious: 20,
      });
      expect(report.topDropOffs[0]).toMatchObject({
        from: 'Profile page',
        to: 'Clicked Edit',
        lost: 2,
      });
      expect(report.eventsInRange).toBe(11);
    });

    it('matches the earliest qualifying step so a later repeat still counts', async () => {
      await insert([
        [A, 'profile_view', '/users/:address', '2026-10-10T10:00:00Z'],
        [A, 'profile_view', '/users/:address', '2026-10-12T10:00:00Z'],
        [A, 'profile_edit_open', '/users/:address', '2026-10-11T10:00:00Z'],
      ]);
      const report = await queries.getFunnel(funnel, range);
      expect(report.steps.map((s) => s.count).slice(0, 2)).toEqual([1, 1]);
    });

    it('returns zeros and eventsInRange 0 for an empty range', async () => {
      const report = await queries.getFunnel(funnel, range);
      expect(report.eventsInRange).toBe(0);
      expect(report.steps.every((s) => s.count === 0)).toBe(true);
      expect(report.topDropOffs).toEqual([]);
    });
  });

  describe('page flow', () => {
    const range = resolveJourneyRange(
      '2026-10-01',
      '2026-10-30',
      new Date('2026-10-30T12:00:00Z'),
    );

    it('counts exits when there is no next page view within 30 minutes', async () => {
      await insert([
        // A: / -> /trends -> (31 min gap) /trends -> end
        [A, 'page_view', '/', '2026-10-10T10:00:00Z'],
        [A, 'page_view', '/trends', '2026-10-10T10:01:00Z'],
        [A, 'page_view', '/trends', '2026-10-10T10:32:00Z'],
        // A's non-page events never count as views.
        [A, 'profile_view', '/users/:address', '2026-10-10T10:02:00Z'],
        // B: / -> /users/:address -> end
        [B, 'page_view', '/', '2026-10-10T11:00:00Z'],
        [B, 'page_view', '/users/:address', '2026-10-10T11:10:00Z'],
        // C: / -> end
        [C, 'page_view', '/', '2026-10-10T12:00:00Z'],
      ]);

      const report = await queries.getPageFlow(range);
      const byPage = Object.fromEntries(report.pages.map((p) => [p.page, p]));
      expect(byPage['/trends']).toMatchObject({
        views: 2,
        visitors: 1,
        exits: 2,
        exitRate: 100,
        nextPages: [],
      });
      expect(byPage['/']).toMatchObject({
        views: 3,
        visitors: 3,
        exits: 1,
        exitRate: 33.3,
      });
      expect(byPage['/'].nextPages).toEqual([
        { page: '/trends', count: 1 },
        { page: '/users/:address', count: 1 },
      ]);
      expect(byPage['/users/:address']).toMatchObject({ views: 1, exits: 1 });
      // Sorted by exits, most first.
      expect(report.pages[0].page).toBe('/trends');
      expect(report.eventsInRange).toBe(7);
    });
  });

  describe('retention', () => {
    it('deletes rows older than 180 days and keeps the rest', async () => {
      const old = new Date(Date.now() - 181 * 24 * 3600 * 1000).toISOString();
      const recent = new Date(
        Date.now() - 179 * 24 * 3600 * 1000,
      ).toISOString();
      await insert([
        [A, 'page_view', '/', old],
        [A, 'page_view', '/', recent],
      ]);
      await app.get(JourneyRetentionService).purgeExpired();
      const rows = await ds.query(`SELECT occurred_at FROM journey_events`);
      expect(rows).toHaveLength(1);
    });
  });

  describe('dashboard login', () => {
    beforeEach(async () => {
      await ds.getRepository(AffiliationDashboardSession).clear();
      await ds.getRepository(AffiliationDashboardAdmin).clear();
    });

    it.each([
      '/api/analytics/journey/funnel',
      '/api/analytics/journey/pages',
      '/api/analytics/journey/preview',
    ])('answers a signed-out fetch to %s with 401', async (path) => {
      await request(server()).get(path).set(FETCH).expect(401);
    });

    it('redirects a signed-out browser from the dashboard page to setup, then to login', async () => {
      const first = await request(server())
        .get('/api/analytics/journey/preview')
        .set(NAVIGATE)
        .expect(302);
      expect(first.headers.location).toBe('/api/bcl-affiliation/auth/setup');

      await auth.setup('operator', 'hunter2!x');
      const second = await request(server())
        .get('/api/analytics/journey/preview')
        .set(NAVIGATE)
        .expect(302);
      expect(second.headers.location).toBe('/api/bcl-affiliation/auth/login');
    });

    it('serves the JSON and renders the page once signed in', async () => {
      const result = await auth.setup('operator', 'hunter2!x');
      expect(result.status).toBe('ok');
      const cookie = `sh_affiliation_session=${(result as { token: string }).token}`;

      const funnel = await request(server())
        .get('/api/analytics/journey/funnel?funnel=trade')
        .set(FETCH)
        .set('Cookie', cookie)
        .expect(200);
      expect(funnel.body.funnel.id).toBe('trade');
      expect(funnel.body.steps).toHaveLength(3);

      await request(server())
        .get('/api/analytics/journey/funnel?funnel=nope')
        .set(FETCH)
        .set('Cookie', cookie)
        .expect(400);

      const pages = await request(server())
        .get(
          '/api/analytics/journey/pages?start_date=2026-10-01&end_date=2026-10-30',
        )
        .set(FETCH)
        .set('Cookie', cookie)
        .expect(200);
      expect(pages.body.range).toEqual({
        start_date: '2026-10-01',
        end_date: '2026-10-30',
      });

      const page = await request(server())
        .get('/api/analytics/journey/preview')
        .set(NAVIGATE)
        .set('Cookie', cookie)
        .expect(200);
      expect(page.text).toContain('Biggest drop-offs');
      expect(page.text).toContain('No journey events in this range yet.');
      expect(page.text).toContain('href="/api/analytics/journey/preview"');
    });
  });
});
