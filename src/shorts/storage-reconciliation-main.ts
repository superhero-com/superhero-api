import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { publisherJson } from './shorts-publisher.config';
import { ShortsStorageReconciliationService } from './shorts-storage-reconciliation.service';

async function bootstrap() {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const [action, path, ...extra] = process.argv.slice(2);
  const fields = {
    start: ['id', 'inventoryId'],
    scan: ['id', 'pages'],
    status: ['id'],
    objects: ['id', 'after', 'limit'],
    references: ['id', 'after', 'limit'],
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
  const { ShortsStorageReconciliationModule } =
    await import('./shorts-storage-reconciliation.module');
  const app = await NestFactory.createApplicationContext(
    ShortsStorageReconciliationModule,
    { logger: false, abortOnError: false },
  );
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(120000)]);
  try {
    const service = app.get(ShortsStorageReconciliationService);
    await service.verify();
    let result;
    if (action === 'start')
      result = await service.start(request.id, request.inventoryId);
    else if (action === 'status') result = await service.status(request.id);
    else if (action === 'objects')
      result = await service.objects(request.id, request.after, request.limit);
    else if (action === 'references')
      result = await service.references(
        request.id,
        request.after,
        request.limit,
      );
    else {
      const pages = request.pages ?? 10;
      if (!Number.isSafeInteger(pages) || pages < 1 || pages > 100)
        throw new Error('Invalid scan page budget');
      for (let i = 0; i < pages; i++) {
        signal.throwIfAborted();
        result = await service.step(request.id, signal);
        if (result.referenceTraversalComplete) break;
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
    'Storage reference scan failed or was interrupted. Check the run status before resuming; committed pages are preserved.',
  );
  process.exitCode = 1;
});
