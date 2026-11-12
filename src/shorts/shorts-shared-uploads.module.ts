import { Module } from '@nestjs/common';
import { ShortsMetadataModule } from './shorts-metadata.module';
import { ShortsPrivateObjectsModule } from './shorts-private-objects.module';
import { ShortsUploadRecordsService } from './shorts-upload-records.service';
import { ShortsSourceService } from './shorts-source.service';
import { ShortsPrivateMediaService } from './shorts-private-media.service';
import { ShortsScratchModule } from './shorts-scratch.module';

@Module({
  imports: [
    ShortsMetadataModule,
    ShortsPrivateObjectsModule,
    ShortsScratchModule,
  ],
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
    ShortsScratchModule,
  ],
})
export class ShortsSharedUploadsModule {}
