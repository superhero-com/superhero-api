/**
 * The dashboard login against a REAL PostgreSQL and a REAL HTTP server.
 *
 * Everything that can go wrong here is invisible to a mocked test: whether the
 * session cookie actually comes back and is accepted on the next request,
 * whether an unauthenticated navigation redirects to a form while an
 * unauthenticated `fetch` gets an honest 401 instead of HTML, whether the
 * lockout counter survives a round trip, and whether the Handlebars templates
 * parse at all. Those are the failures that would strand an operator outside a
 * dashboard during an incident.
 */
import { INestApplication } from '@nestjs/common';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { join } from 'path';
import request from 'supertest';
import { DataSource } from 'typeorm';

import {
  findPostgresBinDir,
  startPostgres,
  PostgresHandle,
} from '@/test/reward-e2e/postgres';
import { AffiliationDashboardAuthController } from '../controllers/affiliation-dashboard-auth.controller';
import { AffiliationDashboardAdmin } from '../entities/affiliation-dashboard-admin.entity';
import { AffiliationDashboardSession } from '../entities/affiliation-dashboard-session.entity';
import {
  AffiliationDashboardAuthService,
  SETUP_ADVISORY_LOCK_KEY,
} from '../services/affiliation-dashboard-auth.service';
import { AffiliationAnalyticsGuard } from './affiliation-analytics.guard';
import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';

const USERNAME = 'admin';
// Deliberately SHORT. The whole point of keeping the hash in the database is
// that a memorable password stays defensible, so the tests use one.
const PASSWORD = 'hunter2!x';

/** See the explorer e2e spec: a sync check so Jest reports skips as skips. */
const binDir = findPostgresBinDir();
const describeWithDb = binDir ? describe : describe.skip;

@Controller('guarded')
@UseGuards(AffiliationAnalyticsGuard)
class GuardedController {
  @Get()
  get() {
    return { secret: 'wallet-to-handle join' };
  }
}

/** A browser opening a page, versus the page's own data call. */
const NAVIGATE = { 'sec-fetch-mode': 'navigate', accept: 'text/html' };
const FETCH = { 'sec-fetch-mode': 'cors', accept: 'application/json' };

describeWithDb('affiliation dashboard login (real DB + HTTP)', () => {
  let pg: PostgresHandle | null = null;
  let ds: DataSource;
  let app: INestApplication;
  let authService: AffiliationDashboardAuthService;

  beforeAll(async () => {
    pg = await startPostgres(binDir as string);
    ds = new DataSource({
      type: 'postgres',
      url: pg.url,
      entities: [AffiliationDashboardAdmin, AffiliationDashboardSession],
      synchronize: true,
    });
    await ds.initialize();

    const moduleRef = await Test.createTestingModule({
      controllers: [AffiliationDashboardAuthController, GuardedController],
      providers: [
        AffiliationDashboardAuthService,
        {
          provide: getRepositoryToken(AffiliationDashboardAdmin),
          useValue: ds.getRepository(AffiliationDashboardAdmin),
        },
        {
          provide: getRepositoryToken(AffiliationDashboardSession),
          useValue: ds.getRepository(AffiliationDashboardSession),
        },
      ],
    })
      // Every request in this file comes from one IP, so the shared per-IP
      // limiter would start returning 429 partway through and make the suite
      // order-dependent. It is pre-existing and tested elsewhere; what belongs
      // here is the per-ACCOUNT lockout below, which the limiter would mask.
      // That it is still wired onto these routes is asserted separately.
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    authService = moduleRef.get(AffiliationDashboardAuthService);
    app = moduleRef.createNestApplication<NestExpressApplication>();
    // Real templates, so a broken .hbs fails here rather than in front of an
    // operator.
    (app as NestExpressApplication).setBaseViewsDir(
      join(__dirname, '..', '..', '..', 'views'),
    );
    (app as NestExpressApplication).setViewEngine('hbs');
    await app.init();
  }, 90000);

  afterAll(async () => {
    await app?.close();
    await ds?.destroy();
    pg?.stop();
  });

  beforeEach(async () => {
    // `.delete({})` is rejected by TypeORM as empty criteria; truncate instead.
    await ds.getRepository(AffiliationDashboardSession).clear();
    await ds.getRepository(AffiliationDashboardAdmin).clear();
  });

  const server = () => app.getHttpServer();

  const completeSetup = async () => {
    const response = await request(server())
      .post('/bcl-affiliation/auth/setup')
      .type('form')
      .send({ username: USERNAME, password: PASSWORD })
      .expect(302);
    return response.headers['set-cookie'] as unknown as string[];
  };

  it('keeps the shared per-IP rate limiter on both credential endpoints', () => {
    // Overridden above, so assert the wiring rather than the behaviour —
    // otherwise removing it from the controller would go unnoticed here.
    for (const method of ['setup', 'login'] as const) {
      const guards =
        Reflect.getMetadata(
          '__guards__',
          AffiliationDashboardAuthController.prototype[method],
        ) || [];
      expect(guards).toContain(RateLimitGuard);
    }
  });

  describe('before anyone has claimed the deployment', () => {
    it('sends a browser to setup, not to a login it cannot pass', async () => {
      const response = await request(server())
        .get('/guarded')
        .set(NAVIGATE)
        .expect(302);
      expect(response.headers.location).toContain('/auth/setup');
    });

    it('renders the setup form', async () => {
      const response = await request(server())
        .get('/bcl-affiliation/auth/setup')
        .set(NAVIGATE)
        .expect(200);
      expect(response.text).toContain('Set up dashboard access');
      expect(response.text).toContain('name="password"');
    });

    it('creates the operator, returns a session cookie and opens the dashboards', async () => {
      const cookies = await completeSetup();
      expect(cookies.join(';')).toContain('sh_affiliation_session=');

      await request(server())
        .get('/guarded')
        .set(NAVIGATE)
        .set('Cookie', cookies)
        .expect(200)
        .expect((res) => expect(res.body.secret).toBe('wallet-to-handle join'));
    });

    it('closes setup once claimed, so a second visitor cannot take it over', async () => {
      await completeSetup();

      const page = await request(server())
        .get('/bcl-affiliation/auth/setup')
        .set(NAVIGATE)
        .expect(302);
      expect(page.headers.location).toContain('/auth/login');

      const attempt = await request(server())
        .post('/bcl-affiliation/auth/setup')
        .type('form')
        .send({ username: 'attacker', password: 'another-password' })
        .expect(302);
      expect(attempt.headers.location).toContain('/auth/login');
      expect(await ds.getRepository(AffiliationDashboardAdmin).count()).toBe(1);
    });

    it('serialises setup on a lock, so a concurrent attempt cannot slip past the check', async () => {
      // The unique index is on `username`, so two simultaneous setups using
      // DIFFERENT usernames collide on nothing and both insert — only
      // serialising the check-and-insert prevents a second operator.
      //
      // Firing concurrent requests does NOT demonstrate that: the transactions
      // queue through the connection pool and finish faster than the window
      // they would have to overlap in, so such a test passes with the lock
      // removed and proves nothing. This holds the lock from another connection
      // instead and asserts setup actually waits on it, which fails the moment
      // the serialisation is gone.
      const blocker = new DataSource({
        type: 'postgres',
        url: (pg as PostgresHandle).url,
        entities: [AffiliationDashboardAdmin, AffiliationDashboardSession],
      });
      await blocker.initialize();
      try {
        await blocker.query('SELECT pg_advisory_lock($1)', [
          SETUP_ADVISORY_LOCK_KEY,
        ]);

        let settled = false;
        const pending = authService
          .setup('firstoperator', PASSWORD)
          .then((result) => {
            settled = true;
            return result;
          });

        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(settled).toBe(false);

        // While it waits its turn, somebody else claims the deployment.
        await ds.getRepository(AffiliationDashboardAdmin).save(
          ds.getRepository(AffiliationDashboardAdmin).create({
            username: 'someoneelse',
            password_hash: '$argon2id$placeholder',
            failed_login_count: 0,
            locked_until: null,
            last_login_at: new Date(),
          }),
        );

        await blocker.query('SELECT pg_advisory_unlock($1)', [
          SETUP_ADVISORY_LOCK_KEY,
        ]);

        // It now re-reads the table rather than acting on its stale check.
        expect((await pending).status).toBe('already_configured');
        expect(await ds.getRepository(AffiliationDashboardAdmin).count()).toBe(
          1,
        );
      } finally {
        await blocker.destroy();
      }
    }, 60000);

    it('rejects a password below the minimum', async () => {
      await request(server())
        .post('/bcl-affiliation/auth/setup')
        .type('form')
        .send({ username: USERNAME, password: 'short' })
        .expect(400);
      expect(await ds.getRepository(AffiliationDashboardAdmin).count()).toBe(0);
    });
  });

  describe('once an operator exists', () => {
    beforeEach(async () => {
      await completeSetup();
    });

    it('redirects an unauthenticated browser to the login form', async () => {
      const response = await request(server())
        .get('/guarded')
        .set(NAVIGATE)
        .expect(302);
      expect(response.headers.location).toContain('/auth/login');
    });

    it('gives a data fetch an honest 401 rather than a redirect to HTML', async () => {
      // A redirected `fetch` lands on the login page and fails to parse as
      // JSON, which reads like a bug in the dashboard rather than a sign-out.
      const response = await request(server())
        .get('/guarded')
        .set(FETCH)
        .expect(401);
      expect(response.body).not.toHaveProperty('secret');
    });

    it('signs in with the right password and keeps the session across requests', async () => {
      const login = await request(server())
        .post('/bcl-affiliation/auth/login')
        .type('form')
        .send({ username: USERNAME, password: PASSWORD })
        .expect(302);
      const cookies = login.headers['set-cookie'] as unknown as string[];

      await request(server())
        .get('/guarded')
        .set(NAVIGATE)
        .set('Cookie', cookies)
        .expect(200);
      // Again, to prove the session is stored rather than merely echoed once.
      await request(server())
        .get('/guarded')
        .set(FETCH)
        .set('Cookie', cookies)
        .expect(200);
    });

    it('is case-insensitive about the username', async () => {
      await request(server())
        .post('/bcl-affiliation/auth/login')
        .type('form')
        .send({ username: 'ADMIN', password: PASSWORD })
        .expect(302);
    });

    it('rejects the wrong password and issues no cookie', async () => {
      const response = await request(server())
        .post('/bcl-affiliation/auth/login')
        .type('form')
        .send({ username: USERNAME, password: 'wrong-password' })
        .expect(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.text).toContain('Wrong username or password');
    });

    it('locks the account after five wrong passwords', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(server())
          .post('/bcl-affiliation/auth/login')
          .type('form')
          .send({ username: USERNAME, password: `wrong-${attempt}` })
          .expect(401);
      }

      // Even the CORRECT password is refused while the lockout holds — that is
      // what makes a short password safe against online guessing.
      const response = await request(server())
        .post('/bcl-affiliation/auth/login')
        .type('form')
        .send({ username: USERNAME, password: PASSWORD })
        .expect(401);
      expect(response.text).toContain('Too many attempts');
    }, 60000);

    it('locks the account even when the wrong guesses arrive in parallel', async () => {
      // MORE than the threshold on purpose. Five would also pass against a
      // version where a late attempt clears the lock a sibling just set: the
      // stragglers are what expose that, since they run their UPDATE after the
      // locking one has already reset the counter.
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          request(server())
            .post('/bcl-affiliation/auth/login')
            .type('form')
            .send({ username: USERNAME, password: `parallel-${i}` }),
        ),
      );

      const admin = await ds
        .getRepository(AffiliationDashboardAdmin)
        .findOne({ where: { username: USERNAME } });
      expect(admin?.locked_until).toBeTruthy();
      expect(admin!.locked_until!.getTime()).toBeGreaterThan(Date.now());

      // And the correct password is refused while it holds.
      const response = await request(server())
        .post('/bcl-affiliation/auth/login')
        .type('form')
        .send({ username: USERNAME, password: PASSWORD })
        .expect(401);
      expect(response.text).toContain('Too many attempts');
    }, 90000);

    it('signing out invalidates the session everywhere', async () => {
      const login = await request(server())
        .post('/bcl-affiliation/auth/login')
        .type('form')
        .send({ username: USERNAME, password: PASSWORD })
        .expect(302);
      const cookies = login.headers['set-cookie'] as unknown as string[];

      await request(server())
        .post('/bcl-affiliation/auth/logout')
        .set('Cookie', cookies)
        .expect(302);

      const after = await request(server())
        .get('/guarded')
        .set(NAVIGATE)
        .set('Cookie', cookies)
        .expect(302);
      expect(after.headers.location).toContain('/auth/login');
    });

    it('refuses an expired session', async () => {
      const login = await request(server())
        .post('/bcl-affiliation/auth/login')
        .type('form')
        .send({ username: USERNAME, password: PASSWORD })
        .expect(302);
      const cookies = login.headers['set-cookie'] as unknown as string[];

      await ds
        .getRepository(AffiliationDashboardSession)
        .createQueryBuilder()
        .update()
        .set({ expires_at: new Date(Date.now() - 1000) })
        .execute();

      const response = await request(server())
        .get('/guarded')
        .set(NAVIGATE)
        .set('Cookie', cookies)
        .expect(302);
      expect(response.headers.location).toContain('/auth/login');
    });

    it('refuses a forged cookie', async () => {
      await request(server())
        .get('/guarded')
        .set(FETCH)
        .set('Cookie', [`sh_affiliation_session=${'f'.repeat(64)}`])
        .expect(401);
    });

    it('never stores the password or the raw session token', async () => {
      const admin = await ds
        .getRepository(AffiliationDashboardAdmin)
        .findOne({ where: { username: USERNAME } });
      expect(admin?.password_hash).toMatch(/^\$argon2id\$/);
      expect(admin?.password_hash).not.toContain(PASSWORD);

      const login = await request(server())
        .post('/bcl-affiliation/auth/login')
        .type('form')
        .send({ username: USERNAME, password: PASSWORD })
        .expect(302);
      const raw = String(login.headers['set-cookie'])
        .split('sh_affiliation_session=')[1]
        .split(';')[0];
      const stored = await ds.getRepository(AffiliationDashboardSession).find();
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.map((s) => s.token_hash)).not.toContain(raw);
    });
  });
});
