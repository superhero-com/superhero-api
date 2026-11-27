import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

async function main() {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const { ProfileMediaWorkerModule } =
    await import('./profile-media-worker.module');
  const app = await NestFactory.create(ProfileMediaWorkerModule, {
    logger: ['error', 'warn'],
    bodyParser: false,
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PROFILE_MEDIA_PORT || 3336), '0.0.0.0');
}
void main().catch(() => {
  console.error('Profile image worker could not start');
  process.exitCode = 1;
});
