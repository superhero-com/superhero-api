import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { publisherJson } from './shorts-publisher.config';
import { ShortsPrivateVersionCleanupService } from './shorts-private-version-cleanup.service';

async function bootstrap() {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const [action, path, ...extra] = process.argv.slice(2);
  const fields = {
    reclaim: ['id', 'scan', 'identity'],
    status: ['id'],
    recover: ['id'],
    cancel: ['id'],
  };
  if (!Object.hasOwn(fields, action) || !path || extra.length)
    throw new Error('Invalid version cleanup command');
  const request = await publisherJson(path);
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).some((key) => !fields[action].includes(key))
  )
    throw new Error('Invalid version cleanup request');
  const { ShortsPrivateVersionCleanupModule } =
    await import('./shorts-private-version-cleanup.module');
  const app = await NestFactory.createApplicationContext(
    ShortsPrivateVersionCleanupModule,
    { logger: false, abortOnError: false },
  );
  const stop = new AbortController(),
    cancel = () => stop.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const service = app.get(ShortsPrivateVersionCleanupService);
    await service.verify();
    const result =
      action === 'reclaim'
        ? await service.reclaim(
            request.id,
            request.scan,
            request.identity,
            stop.signal,
          )
        : action === 'recover'
          ? await service.recover(request.id, stop.signal)
          : action === 'cancel'
            ? await service.cancel(request.id)
            : await service.status(request.id);
    console.log(JSON.stringify(result));
  } finally {
    stop.abort();
    await app.close();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
void bootstrap().catch(() => {
  console.error(
    'Private version cleanup failed or was interrupted. Read its saved status; recover uncertain outcomes before retrying.',
  );
  process.exitCode = 1;
});
