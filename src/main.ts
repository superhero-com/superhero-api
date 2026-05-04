import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { join } from 'path';
import hbs from 'hbs';
import { readFileSync } from 'fs';
import { AppModule } from './app.module';
import { DEBUG_ENABLED } from './configs';
import {
  hasExplicitAllowlist,
  parseAllowedOrigins,
} from './configs/allowed-origins';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Global process-level guards to surface and prevent silent killers
// NOTE: After logging we explicitly exit with code 1 so that the process
// manager (Docker, PM2, systemd, etc.) can restart the service. Continuing
// after these events is unsafe.
process.on('uncaughtException', (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('UNCAUGHT EXCEPTION, process will exit:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  // eslint-disable-next-line no-console
  console.error('UNHANDLED REJECTION, process will exit:', reason);
  process.exit(1);
});

process.on('exit', (code: number) => {
  // eslint-disable-next-line no-console
  console.error('Process exiting with code', code);
});

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

  await app.listen(process.env.APP_PORT ?? 3000);
}
void bootstrap();
