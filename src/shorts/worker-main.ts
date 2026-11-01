import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { shortsWorkerConfig } from './shorts-worker.config';

async function bootstrap() {
  // Validate the worker's role before importing any runtime module.
  await shortsWorkerConfig();
  const { ShortsWorkerModule } = await import('./shorts-worker.module');
  const app = await NestFactory.createApplicationContext(ShortsWorkerModule);
  app.enableShutdownHooks(undefined, { useProcessExit: true });
}
void bootstrap().catch(() => {
  console.error(
    'Shorts media worker startup failed. Check deployment, database and private service configuration.',
  );
  process.exitCode = 1;
});
