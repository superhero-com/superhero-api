import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { publisherJson } from './shorts-publisher.config';
import {
  deliveryOperation,
  isPrivateInputOperation,
  runDeliveryOperation,
} from './shorts-delivery-operation';
import { ShortsBackfillService } from './shorts-backfill.service';
import { ShortsDeliveryActivationService } from './shorts-delivery-activation.service';
import { ShortsStreamingService } from './shorts-streaming.service';
import { ShortsApiPublicationService } from './shorts-api-publication.service';
import { ShortsService } from './shorts.service';
import { shortsStorageScope } from './shorts-runtime-scope';
import { ShortsDeliveryRetirementService } from './shorts-delivery-retirement.service';
import { ShortsPrivateInputRetirementService } from './shorts-private-input-retirement.service';
import { ShortsPrivateReferenceBarriersService } from './shorts-private-reference-barriers.service';
import { ShortsInputReclamationService } from './shorts-input-reclamation.service';
import { ShortsStorageRecoveryService } from './shorts-storage-recovery.service';
import { ShortsInputReclamationReservationsService } from './shorts-input-reclamation-reservations.service';
import { ShortsInputReclamationPermitsService } from './shorts-input-reclamation-permits.service';
import { ShortsReclamationReleaseService } from './shorts-reclamation-release.service';
import { ShortsStorageRecoveriesService } from './shorts-storage-recoveries.service';

async function bootstrap() {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const [action, path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error('Invalid delivery command');
  const input = deliveryOperation(action, await publisherJson(path));
  const { ShortsDeliveryOperationsModule } =
    await import('./shorts-delivery-operations.module');
  const app = await NestFactory.createApplicationContext(
    await ShortsDeliveryOperationsModule.register(),
    { logger: false, abortOnError: false },
  );
  const stop = new AbortController(),
    cancel = () => stop.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    // Verify the existing read/enqueue boundary without starting hosted jobs.
    await app.get(ShortsApiPublicationService).initialize();
    const result = await runDeliveryOperation(
      input,
      app.get(ShortsBackfillService),
      app.get(ShortsDeliveryActivationService),
      stop.signal,
      app.get(ShortsStreamingService),
      isPrivateInputOperation(action)
        ? {
            scope: shortsStorageScope(app.get(ShortsService).chain),
            encoded: app.get(ShortsDeliveryRetirementService),
            private: app.get(ShortsPrivateInputRetirementService),
            barriers: app.get(ShortsPrivateReferenceBarriersService),
            pins: {
              coordinator: app.get(ShortsInputReclamationService),
              recovery: app.get(ShortsStorageRecoveryService),
              reservations: app.get(ShortsInputReclamationReservationsService),
              permits: app.get(ShortsInputReclamationPermitsService),
              releases: app.get(ShortsReclamationReleaseService),
              recoveries: app.get(ShortsStorageRecoveriesService),
            },
          }
        : undefined,
    );
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
    'Delivery operation failed or was interrupted. Read the saved operation status before retrying.',
  );
  process.exitCode = 1;
});
