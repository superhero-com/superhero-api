/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Boot a real HTTP server and check what a browser actually receives.
 *
 * The unit spec asserts that the guard CALLS `setHeader`, which is not the same
 * claim as "the browser gets a `WWW-Authenticate` header and shows its prompt".
 * If Nest's exception filter discarded headers set before the throw, the whole
 * feature would silently degrade to a bare 401 — no prompt, no way in — and the
 * unit spec would still pass. That gap is the reason this file exists.
 */
import type { INestApplication } from '@nestjs/common';
// Default import, not `import * as`: supertest v7 ships a namespace whose
// callable lives on `.default`, so the star form type-errors and would throw at
// runtime. (`test/app.e2e-spec.ts` still has the old form and does not compile.)
import request from 'supertest';

const USER = 'admin';
const PASSWORD = 'p'.repeat(32);

/**
 * Build an app whose single route is guarded, under an isolated module registry
 * so the guard reads the constants this test wants.
 *
 * Everything — Nest itself included — is required INSIDE the isolated registry.
 * Importing the decorators at file scope instead gives the controller one copy
 * of `@nestjs/common` and the guard another, so the `UnauthorizedException` the
 * guard throws is not the `HttpException` the outer exception filter tests
 * against: every rejection surfaces as a 500 and the challenge never ships.
 */
const appWith = async (
  user: string,
  password: string,
): Promise<INestApplication> => {
  let app!: INestApplication;
  await jest.isolateModulesAsync(async () => {
    jest.doMock('@/configs/constants', () => ({
      AFFILIATION_ANALYTICS_USER: user,
      AFFILIATION_ANALYTICS_PASSWORD: password,
      AFFILIATION_ANALYTICS_MIN_PASSWORD_LENGTH: 16,
    }));
    const { Controller, Get, UseGuards } = require('@nestjs/common');
    const { Test } = require('@nestjs/testing');
    const {
      AffiliationAnalyticsGuard,
    } = require('./affiliation-analytics.guard');

    class GuardedController {
      get() {
        return { secret: 'wallet-to-handle join' };
      }
    }
    // Applied manually because the decorators come from `require`, which cannot
    // be used in decorator position.
    Get()(
      GuardedController.prototype,
      'get',
      Object.getOwnPropertyDescriptor(GuardedController.prototype, 'get'),
    );
    UseGuards(AffiliationAnalyticsGuard)(GuardedController);
    Controller('dashboard')(GuardedController);

    const moduleRef = await Test.createTestingModule({
      controllers: [GuardedController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  return app;
};

describe('affiliation dashboards over real HTTP', () => {
  let app: INestApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('sends a WWW-Authenticate challenge the browser can prompt on', async () => {
    app = await appWith(USER, PASSWORD);
    const response = await request(app.getHttpServer())
      .get('/dashboard')
      .expect(401);

    // The header must survive the thrown exception all the way to the wire.
    expect(response.headers['www-authenticate']).toMatch(/^Basic realm=/);
    expect(response.body).not.toHaveProperty('secret');
  });

  it('serves the data once the right credentials arrive', async () => {
    app = await appWith(USER, PASSWORD);
    await request(app.getHttpServer())
      .get('/dashboard')
      .auth(USER, PASSWORD)
      .expect(200)
      .expect((res) => expect(res.body.secret).toBe('wallet-to-handle join'));
  });

  it('refuses a wrong password and challenges again', async () => {
    app = await appWith(USER, PASSWORD);
    const response = await request(app.getHttpServer())
      .get('/dashboard')
      .auth(USER, 'x'.repeat(32))
      .expect(401);
    expect(response.headers['www-authenticate']).toMatch(/^Basic realm=/);
  });

  it('returns 503 with no challenge when no password is configured', async () => {
    app = await appWith(USER, '');
    const response = await request(app.getHttpServer())
      .get('/dashboard')
      .expect(503);

    // No challenge, or the browser would prompt forever for a password that
    // cannot be accepted.
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(JSON.stringify(response.body)).toMatch(
      /AFFILIATION_ANALYTICS_PASSWORD/,
    );
  });
});
