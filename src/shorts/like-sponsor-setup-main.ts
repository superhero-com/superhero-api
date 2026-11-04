import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ShortsLikeSponsorSetupService } from './shorts-like-sponsor-setup.service';

async function bootstrap() {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const operation = process.argv[2] ?? 'setup';
  if (!['setup', 'pause', 'enable'].includes(operation))
    throw new Error('Unsupported sponsorship operation');
  const { ShortsLikeSponsorSetupModule } =
    await import('./shorts-like-sponsor-setup.module');
  const app = await NestFactory.createApplicationContext(
    ShortsLikeSponsorSetupModule,
  );
  try {
    const service = app.get(ShortsLikeSponsorSetupService);
    console.log(
      JSON.stringify(
        operation === 'setup'
          ? await service.setup()
          : await service.setPaused(operation === 'pause'),
      ),
    );
  } finally {
    await app.close();
  }
}
void bootstrap().catch(() => {
  console.error(
    'Sponsorship administration failed; verify exact binding, immutable policy and dedicated database roles.',
  );
  process.exitCode = 1;
});
