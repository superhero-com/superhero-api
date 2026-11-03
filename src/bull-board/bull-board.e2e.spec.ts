/**
 * Bull Board over a real HTTP server. The guard sits on a catch-all controller
 * that hands each request to the board's own Express router, so only a real
 * request shows that the UI and its JSON API are both behind the login and
 * that read-only mode reaches the write routes.
 */
import { INestApplication } from '@nestjs/common';
import { getQueueToken, Processor } from '@nestjs/bull';
import { Test } from '@nestjs/testing';
import Bull from 'bull';
import request from 'supertest';
import { BullBoardModule } from './bull-board.module';
import { BullBoardSettings } from './bull-board.settings';

const QUEUE = 'example';
// Basic auth splits user and password at the first colon, so the password
// carries one to prove a colon inside it survives.
const CREDENTIALS = { user: 'ops', password: 'a:password-of-24-chars!!' };

// Bull Board only checks `instanceof Bull`, and read-only mode refuses a write
// before touching the queue, so these tests need no Redis.
const queue = Object.assign(Object.create(Bull.prototype), { name: QUEUE });

@Processor(QUEUE)
class ExampleProcessor {}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

async function startApp(
  settings: BullBoardSettings,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [BullBoardModule.forRoot(settings)],
    providers: [
      ExampleProcessor,
      { provide: getQueueToken(QUEUE), useValue: queue },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
  return app;
}

describe('Bull Board (real HTTP)', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it('is not mounted when disabled', async () => {
    app = await startApp({ enabled: false });
    await request(app.getHttpServer()).get('/api/bull-board/').expect(404);
  });

  describe('with credentials', () => {
    beforeEach(async () => {
      app = await startApp({
        enabled: true,
        credentials: CREDENTIALS,
        readOnly: true,
      });
    });

    it('challenges a request without a login, for the UI and the API', async () => {
      const ui = await request(app.getHttpServer())
        .get('/api/bull-board/')
        .expect(401);
      expect(ui.headers['www-authenticate']).toMatch(/^Basic realm=/);

      await request(app.getHttpServer())
        .get('/api/bull-board/api/queues')
        .expect(401);
      await request(app.getHttpServer())
        .put(`/api/bull-board/api/queues/${QUEUE}/pause`)
        .expect(401);
    });

    it('rejects a wrong user or password', async () => {
      for (const header of [
        basic(CREDENTIALS.user, 'not-the-password'),
        basic('someone', CREDENTIALS.password),
        'Basic not-base64',
      ]) {
        await request(app.getHttpServer())
          .get('/api/bull-board/')
          .set('Authorization', header)
          .expect(401);
      }
    });

    it('serves the dashboard to the right login', async () => {
      await request(app.getHttpServer())
        .get('/api/bull-board/')
        .set('Authorization', basic(CREDENTIALS.user, CREDENTIALS.password))
        .expect(200)
        .expect('Content-Type', /html/);
    });

    it('refuses writes in read-only mode', async () => {
      await request(app.getHttpServer())
        .put(`/api/bull-board/api/queues/${QUEUE}/pause`)
        .set('Authorization', basic(CREDENTIALS.user, CREDENTIALS.password))
        .expect(405);
    });
  });

  it('needs no login when no credentials are configured', async () => {
    app = await startApp({ enabled: true, readOnly: true });
    await request(app.getHttpServer()).get('/api/bull-board/').expect(200);
  });

  it('stays read-only when the settings do not allow writes', async () => {
    app = await startApp({ enabled: true });
    await request(app.getHttpServer())
      .put(`/api/bull-board/api/queues/${QUEUE}/pause`)
      .expect(405);
  });
});
