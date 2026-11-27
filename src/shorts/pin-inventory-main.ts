import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { publisherJson } from './shorts-publisher.config';
import { ShortsPinInventoryService } from './shorts-pin-inventory.service';

async function bootstrap() {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const [action, path, ...extra] = process.argv.slice(2);
  const fields = {
    scan: ['id', 'hlsRun'],
    status: ['id'],
    entries: ['id', 'after', 'limit'],
    missing: ['id', 'after', 'limit'],
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
  const { ShortsPinInventoryModule } =
    await import('./shorts-pin-inventory.module');
  const app = await NestFactory.createApplicationContext(
    ShortsPinInventoryModule,
    { logger: false, abortOnError: false },
  );
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(120000)]);
  try {
    const service = app.get(ShortsPinInventoryService);
    await service.verify();
    let result;
    if (action === 'scan')
      result = await service.scan(request.id, request.hlsRun, signal);
    else if (action === 'status') result = await service.status(request.id);
    else if (action === 'entries')
      result = await service.entries(request.id, request.after, request.limit);
    else
      result = await service.missing(request.id, request.after, request.limit);
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
    'IPFS inventory failed or was interrupted. Check status; incomplete runs cannot resume. Preserve the evidence and start a new run.',
  );
  process.exitCode = 1;
});
