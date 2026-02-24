import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { join } from 'path';
import hbs from 'hbs';
import { readFileSync } from 'fs';
import { AppModule } from './app.module';
import { DEBUG_ENABLED } from './configs';

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

  app.enableCors();
  app.setGlobalPrefix('api');

  const config = new DocumentBuilder()
    .setTitle('WORD CRAFT Scan')
    .setDescription('The WORD CRAFT Scan API')
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

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
