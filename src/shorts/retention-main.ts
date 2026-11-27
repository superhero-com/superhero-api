import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ShortsRetentionService } from './shorts-retention.service';
import { publisherJson } from './shorts-publisher.config';

async function bootstrap() {
  // Never load the API's .env, storage credentials or signer configuration.
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const [action, requestPath, ...extra] = process.argv.slice(2);
  if (
    !['inventory', 'holds', 'hold', 'release'].includes(action) ||
    !requestPath ||
    extra.length
  )
    throw new Error(
      'Use a retention action and an absolute JSON request-file path',
    );
  const request = await publisherJson(requestPath);
  const allowed = {
    inventory: ['after', 'limit'],
    holds: ['resourceId', 'after', 'limit'],
    hold: ['id', 'resourceId', 'reason', 'reference'],
    release: ['id'],
  }[action];
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).some((key) => !allowed.includes(key))
  )
    throw new Error('Invalid retention request');
  const { ShortsRetentionModule } = await import('./shorts-retention.module');
  const app = await NestFactory.createApplicationContext(
    ShortsRetentionModule,
    { logger: false, abortOnError: false },
  );
  try {
    const service = app.get(ShortsRetentionService);
    await service.verify();
    const result =
      action === 'inventory'
        ? await service.inventory(request.after, request.limit)
        : action === 'holds'
          ? await service.holds(
              request.resourceId,
              request.after,
              request.limit,
            )
          : action === 'hold'
            ? await service.hold(request)
            : await service.release(request.id);
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
}
void bootstrap().catch(() => {
  console.error(
    'Retention operation failed. Check the request, testnet manifest, migrations and restricted database login. For uncertain writes, query the same hold ID before retrying.',
  );
  process.exitCode = 1;
});
