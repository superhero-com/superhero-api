import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  legacyStorageConfig,
  ShortsLegacyStorageService,
} from './shorts-legacy-storage.service';

async function bootstrap() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--apply'].includes(args[0]))
    throw new Error('Use --check or --apply');
  await legacyStorageConfig();
  const { ShortsLegacyStorageModule } =
    await import('./shorts-legacy-storage.module');
  const app = await NestFactory.createApplicationContext(
    ShortsLegacyStorageModule,
    { logger: false },
  );
  try {
    console.log(
      JSON.stringify(
        await app.get(ShortsLegacyStorageService).run(args[0] === '--apply'),
      ),
    );
  } finally {
    await app.close();
  }
}
void bootstrap().catch(() => {
  console.error(
    'Legacy storage migration stopped. Check the source, original key, deployment and private services. Existing files are retained; retry after correcting the cause.',
  );
  process.exitCode = 1;
});
