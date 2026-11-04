import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { publisherJson } from './shorts-publisher.config';
import { ShortsPrivateInputCleanupService } from './shorts-private-input-cleanup.service';
import { privateCleanupCandidates } from './shorts-private-cleanup-batch';

async function bootstrap() {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const [action, path, ...extra] = process.argv.slice(2);
  const fields = {
    reclaim: ['id', 'barrier', 'inventory', 'identity'],
    'reclaim-batch': ['operations'],
    status: ['id'],
    recover: ['id'],
  };
  if (!Object.hasOwn(fields, action) || !path || extra.length)
    throw new Error('Invalid private input cleanup command');
  const request = await publisherJson(path);
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).length !== fields[action].length ||
    (action !== 'reclaim-batch' &&
      fields[action].some((key) => typeof request[key] !== 'string')) ||
    Object.keys(request).some((key) => !fields[action].includes(key))
  )
    throw new Error('Invalid private input cleanup request');
  const batch =
    action === 'reclaim-batch'
      ? privateCleanupCandidates(request.operations)
      : undefined;
  const { ShortsPrivateInputCleanupModule } =
    await import('./shorts-private-input-cleanup.module');
  const app = await NestFactory.createApplicationContext(
    ShortsPrivateInputCleanupModule,
    { logger: false, abortOnError: false },
  );
  const stop = new AbortController(),
    cancel = () => stop.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const service = app.get(ShortsPrivateInputCleanupService);
    await service.verify();
    const result = batch
      ? await service.reclaimMany(batch, stop.signal)
      : action === 'reclaim'
        ? await service.reclaim(
            request.id,
            request.barrier,
            request.inventory,
            request.identity,
            stop.signal,
          )
        : action === 'recover'
          ? await service.recover(request.id, stop.signal)
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
    'Private input cleanup failed or was interrupted. Read saved status and recover issued outcomes before retrying.',
  );
  process.exitCode = 1;
});
