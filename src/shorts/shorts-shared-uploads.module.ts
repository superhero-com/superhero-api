import { Module } from '@nestjs/common';
import { ShortsMetadataModule } from './shorts-metadata.module';
import { ShortsPrivateObjectsModule } from './shorts-private-objects.module';
import { ShortsUploadRecordsService } from './shorts-upload-records.service';
import { ShortsSourceService } from './shorts-source.service';
import { ShortsPrivateMediaService } from './shorts-private-media.service';

@Module({
  imports: [ShortsMetadataModule, ShortsPrivateObjectsModule],
  providers: [
    ShortsUploadRecordsService,
    ShortsSourceService,
    ShortsPrivateMediaService,
  ],
  exports: [
    ShortsUploadRecordsService,
    ShortsSourceService,
    ShortsPrivateMediaService,
    ShortsPrivateObjectsModule,
  ],
})
export class ShortsSharedUploadsModule {}
