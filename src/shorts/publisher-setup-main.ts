import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ShortsPublisherSetupService } from './shorts-publisher-setup.service';

async function bootstrap() {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const { ShortsPublisherSetupModule } =
    await import('./shorts-publisher-setup.module');
  const app = await NestFactory.createApplicationContext(
    ShortsPublisherSetupModule,
  );
  try {
    const budget = await app.get(ShortsPublisherSetupService).setup();
    console.log(
      'Publication policy and role enrollment initialized. Runtime privilege checks remain mandatory at startup.',
    );
    console.log(
      `Retained upload budget: ${budget.maxUploads} uploads / ${budget.maxSourceBytes} source bytes; used ${budget.usedUploads} / ${budget.usedSourceBytes}.`,
    );
  } finally {
    await app.close();
  }
}
void bootstrap().catch(() => {
  console.error(
    'Publisher setup failed. Check the public deployment, limits, migrations and dedicated database roles.',
  );
  process.exitCode = 1;
});
