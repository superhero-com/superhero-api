import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { likeSponsorConfig } from './shorts-like-sponsorship.config';

async function bootstrap() {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const recover = process.argv.includes('--recover');
  if (recover) {
    process.env.SHORTS_LIKE_SPONSOR_RECOVERY = '1';
    process.env.SHORTS_LIKE_SPONSOR_ENABLED = 'false';
  } else if (process.env.SHORTS_LIKE_SPONSOR_RECOVERY) {
    throw new Error('Recovery requires the explicit --recover command');
  }
  await likeSponsorConfig(true);
  const { ShortsLikeSponsorModule } =
    await import('./shorts-like-sponsor.module');
  const app = await NestFactory.createApplicationContext(
    ShortsLikeSponsorModule,
  );
  app.enableShutdownHooks(undefined, { useProcessExit: true });
  if (recover) {
    const { ShortsLikeSponsorshipRepository } =
      await import('./shorts-like-sponsorship-repository.service');
    const { ShortsLikeSponsorWorker } =
      await import('./shorts-like-sponsor-worker.service');
    const repository = app.get(ShortsLikeSponsorshipRepository);
    const worker = app.get(ShortsLikeSponsorWorker);
    const deadline = Date.now() + 30 * 60 * 1000;
    try {
      let state = await repository.call('recovery_status');
      if (!state.quarantined) {
        await repository.call('quarantine', {
          reason: 'bootstrap',
          anchorVersion: state.version,
        });
      }
      for (;;) {
        await worker.tick();
        state = await repository.call('recovery_status');
        if (state.remaining === 0) {
          await worker.finishRecovery();
          state = await repository.call('recovery_status');
          console.log(
            JSON.stringify({
              recovered: true,
              admissionEnabled: false,
              paused: state.paused,
            }),
          );
          break;
        }
        if (Date.now() >= deadline)
          throw new Error('Recovery remains unresolved; quarantine retained');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } finally {
      await app.close();
    }
  }
}
void bootstrap().catch(() => {
  console.error(
    'Like sponsor startup failed. Check its isolated configuration and restricted queue role.',
  );
  process.exitCode = 1;
});
