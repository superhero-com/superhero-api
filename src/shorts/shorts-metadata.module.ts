import { ShortsDatabaseModule } from './shorts-database.module';
import { Module } from '@nestjs/common';
import { ShortsMetadataService } from './shorts-metadata.service';
import { ShortsSessionsService } from './shorts-sessions.service';
import { ShortsStreamJobsService } from './shorts-stream-jobs.service';
import { ShortsMeasurementsService } from './shorts-measurements.service';
import { ShortsDeliveryPackagesService } from './shorts-delivery-packages.service';
import { ShortsDeliveryGenerationsService } from './shorts-delivery-generations.service';
import { ShortsDeliveryStagingService } from './shorts-delivery-staging.service';
import { ShortsDeliverySelectionService } from './shorts-delivery-selection.service';
import { ShortsDeliveryInputRetirementService } from './shorts-delivery-input-retirement.service';
import { ShortsPrivateInputRetirementsService } from './shorts-private-input-retirements.service';
import { ShortsPrivateReferenceBarriersService } from './shorts-private-reference-barriers.service';
import { ShortsPrivateInputCleanupJournalService } from './shorts-private-input-cleanup-journal.service';
import { ShortsInputReclamationReservationsService } from './shorts-input-reclamation-reservations.service';
import { ShortsPinTransfersService } from './shorts-pin-transfers.service';
import { ShortsInputReclamationPermitsService } from './shorts-input-reclamation-permits.service';
import { ShortsReclamationReleaseService } from './shorts-reclamation-release.service';
import { ShortsStorageRecoveriesService } from './shorts-storage-recoveries.service';

// Shared PostgreSQL comes from the normal API or a dedicated worker's TypeORM
// module. This module has no dependency on SQLite, wallets or media decoders.
@Module({
  imports: [ShortsDatabaseModule],
  providers: [
    ShortsMetadataService,
    ShortsSessionsService,
    ShortsStreamJobsService,
    ShortsMeasurementsService,
    ShortsDeliveryPackagesService,
    ShortsDeliveryGenerationsService,
    ShortsDeliveryStagingService,
    ShortsDeliverySelectionService,
    ShortsDeliveryInputRetirementService,
    ShortsPrivateInputRetirementsService,
    ShortsPrivateReferenceBarriersService,
    ShortsPrivateInputCleanupJournalService,
    ShortsInputReclamationReservationsService,
    ShortsPinTransfersService,
    ShortsInputReclamationPermitsService,
    ShortsReclamationReleaseService,
    ShortsStorageRecoveriesService,
  ],
  exports: [
    ShortsMetadataService,
    ShortsSessionsService,
    ShortsStreamJobsService,
    ShortsMeasurementsService,
    ShortsDeliveryPackagesService,
    ShortsDeliveryGenerationsService,
    ShortsDeliveryStagingService,
    ShortsDeliverySelectionService,
    ShortsDeliveryInputRetirementService,
    ShortsPrivateInputRetirementsService,
    ShortsPrivateReferenceBarriersService,
    ShortsPrivateInputCleanupJournalService,
    ShortsInputReclamationReservationsService,
    ShortsPinTransfersService,
    ShortsInputReclamationPermitsService,
    ShortsReclamationReleaseService,
    ShortsStorageRecoveriesService,
  ],
})
export class ShortsMetadataModule {}
