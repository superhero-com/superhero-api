import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { shortsPublisherConfig } from './shorts-publisher.config';

async function bootstrap() {
  // The entrypoint accepts an explicit --env-file. Never inherit the API's .env.
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  await shortsPublisherConfig();
  const { ShortsPublisherModule } = await import('./shorts-publisher.module');
  const app = await NestFactory.createApplicationContext(ShortsPublisherModule);
  app.enableShutdownHooks(undefined, { useProcessExit: true });
}
void bootstrap().catch(() => {
  console.error(
    'Shorts publisher startup failed. Check its dedicated configuration and database role.',
  );
  process.exitCode = 1;
});
