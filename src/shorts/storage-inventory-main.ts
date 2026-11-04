import 'reflect-metadata';
import { ShortsMultipartInventoryService } from './shorts-multipart-inventory.service';
import { NestFactory } from '@nestjs/core';
import { publisherJson } from './shorts-publisher.config';
import { ShortsStorageInventoryService } from './shorts-storage-inventory.service';

async function bootstrap() {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const [action, path, ...extra] = process.argv.slice(2);
  const fields = {
    start: ['id'],
    scan: ['id', 'pages'],
    status: ['id'],
    objects: ['id', 'after', 'limit'],
    'multipart-start': ['id'],
    'multipart-scan': ['id', 'pages'],
    'multipart-status': ['id'],
    'multipart-uploads': ['id', 'after', 'limit'],
    'multipart-parts': ['id', 'upload', 'after', 'limit'],
  };
  if (!Object.hasOwn(fields, action) || !path || extra.length)
    throw new Error('Invalid inventory command');
  const request = await publisherJson(path);
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).some((key) => !fields[action].includes(key))
  )
    throw new Error('Invalid inventory request');
  const { ShortsStorageInventoryModule } =
    await import('./shorts-storage-inventory.module');
  const app = await NestFactory.createApplicationContext(
    ShortsStorageInventoryModule,
    { logger: false, abortOnError: false },
  );
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(120000)]);
  try {
    const multipart = action.startsWith('multipart-');
    const operation = multipart ? action.slice('multipart-'.length) : action;
    const service = multipart
      ? app.get(ShortsMultipartInventoryService)
      : app.get(ShortsStorageInventoryService);
    await service.verify();
    let result;
    if (operation === 'start') result = await service.start(request.id);
    else if (operation === 'status') result = await service.status(request.id);
    else if (operation === 'objects')
      result = await app
        .get(ShortsStorageInventoryService)
        .objects(request.id, request.after, request.limit);
    else if (operation === 'uploads')
      result = await app
        .get(ShortsMultipartInventoryService)
        .uploads(request.id, request.after, request.limit);
    else if (operation === 'parts')
      result = await app
        .get(ShortsMultipartInventoryService)
        .parts(request.id, request.upload, request.after, request.limit);
    else {
      const pages = request.pages ?? 10;
      if (!Number.isSafeInteger(pages) || pages < 1 || pages > 100)
        throw new Error('Invalid scan page budget');
      for (let i = 0; i < pages; i++) {
        signal.throwIfAborted();
        result = await service.step(request.id, signal);
        if (result.listingComplete) break;
      }
    }
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
    'Storage inventory failed or was interrupted. Check the run status before resuming; committed pages are preserved.',
  );
  process.exitCode = 1;
});
