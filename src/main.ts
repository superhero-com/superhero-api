import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import { join } from 'path';
import hbs from 'hbs';
import { readFileSync } from 'fs';
import { AppModule } from './app.module';
import { DEBUG_ENABLED } from './configs';
import {
  hasExplicitAllowlist,
  parseAllowedOrigins,
} from './configs/allowed-origins';
import { resolveTrustProxyValue } from './configs/trust-proxy';
import { registerProcessGuards } from './process-guards';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const bootstrapLogger = new Logger('Bootstrap');

// Global process-level guards to surface and prevent silent killers
// (uncaughtException / unhandledRejection → log + exit 1).
registerProcessGuards();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: DEBUG_ENABLED
      ? ['error', 'warn', 'log', 'debug', 'verbose']
      : ['error'],
  });

  // Hardening headers: X-Frame-Options, X-Content-Type-Options,
  // Referrer-Policy, HSTS, etc. CSP is disabled because this is an API
  // server, not a browser app, and the admin UIs we host (Swagger,
  // GraphiQL, Bull Board) all inject inline `<script>` tags that the
  // default `script-src 'self'` policy blocks — rendering blank pages.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Compress JSON responses; list endpoints return 100-item pages that
  // shrink 70-85% under gzip.
  app.use(compression());

  // This is a public API — by default we allow every browser origin so
  // unknown third-party consumers (explorers, dashboards, embeds) can
  // call us. Operators can still pin to an allowlist via
  // `ALLOWED_ORIGINS` for private deployments. Credentials are only
  // enabled when an explicit allowlist is configured, because browsers
  // reject `Access-Control-Allow-Credentials: true` alongside a wildcard
  // origin — and nothing in this codebase relies on cookies anyway
  // (auth uses explicit `x-api-key` / `Authorization` headers).
  app.enableCors({
    origin: parseAllowedOrigins(),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: hasExplicitAllowlist(),
  });
  // Behind a reverse proxy (nginx / ELB / Cloudflare) Express otherwise reports
  // the proxy's IP as `req.ip` for every client, which collapses the per-IP
  // RateLimitGuard into one shared bucket (self-DoS) and blinds any IP-based
  // logging. `TRUST_PROXY` lets ops declare the hop count / preset so Express
  // resolves the real client IP from X-Forwarded-For. Left UNSET by default
  // because trusting XFF without a proxy in front makes the client IP spoofable
  // — only enable it when something trustworthy actually sets the header.
  // Accept a hop count ("1"), a boolean ("true"/"false"), or a preset/CIDR
  // ("loopback", "10.0.0.0/8") passed straight through to Express.
  const trustProxyValue = resolveTrustProxyValue(
    process.env.TRUST_PROXY,
    (rawValue, resolvedValue) => {
      bootstrapLogger.warn(
        `TRUST_PROXY="${rawValue}" is not a hop count or true/false; passing "${resolvedValue}" to Express as a preset/CIDR value. Double-check this is intentional.`,
      );
    },
  );
  if (trustProxyValue !== undefined) {
    app.set('trust proxy', trustProxyValue);
  }

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Swagger exposes the full endpoint surface and parameter schemas; only
  // mount it outside production unless an operator explicitly opts in.
  if (!IS_PRODUCTION || process.env.ENABLE_SWAGGER === 'true') {
    const config = new DocumentBuilder()
      .setTitle('WORD CRAFT Scan')
      .setDescription('The WORD CRAFT Scan API')
      .setVersion('1.0')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api', app, document);
  }

  app.useStaticAssets(join(__dirname, '..', 'public'));
  app.setBaseViewsDir(join(__dirname, '..', 'views'));
  app.setViewEngine('hbs');
  // `hbs` in this repo exposes `handlebars.registerPartial` (but not `registerPartials`).
  // Register our shared layout explicitly so `{{#> main-layout}}` works.
  const viewsDir = join(__dirname, '..', 'views');
  const mainLayout = readFileSync(join(viewsDir, 'main-layout.hbs'), 'utf8');
  hbs.handlebars.registerPartial('main-layout', mainLayout);
  // Helper used by the shared layout to mark active sidebar links.
  hbs.handlebars.registerHelper('eq', (a: any, b: any) => a === b);

  // Run lifecycle teardown (OnModuleDestroy / OnApplicationShutdown) on
  // SIGTERM/SIGINT. Without this, owned ioredis clients and pub/sub subscribers
  // (notifications, announcements, websocket, indexer, …) are never quit()ed on
  // a graceful shutdown — they leak until the process is force-killed.
  app.enableShutdownHooks();

  await app.listen(process.env.APP_PORT ?? 3000);
}

// One image, ONE process (worker mode removed — see
// `agent/api/tasks/token-gated-room/deworker-plan.md`): HTTP API + chain indexer
// AND the NIP-29 relay duties (writer/subscriber + Bull consumers +
// backfill/reconcile/membership-sync) all run here. The relay duties self-enable
// iff a relay is configured (`TG_RELAY_URL` + `TG_BOT_NSEC`); otherwise they stay
// dormant and the API still boots and indexes.
void bootstrap();
