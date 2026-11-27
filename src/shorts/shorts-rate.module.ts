import { Module } from '@nestjs/common';
import { ShortsCoreModule } from './shorts-core.module';
import { SHORTS_RATE_CONFIG, shortsRateConfig } from './shorts-rate.config';
import { ShortsRateService } from './shorts-rate.service';
import { ShortsUploadAdmissionService } from './shorts-upload-admission.service';
import { ShortsMediaAdmissionService } from './shorts-media-admission.service';

@Module({
  imports: [ShortsCoreModule],
  providers: [
    { provide: SHORTS_RATE_CONFIG, useFactory: shortsRateConfig },
    ShortsRateService,
    ShortsUploadAdmissionService,
    ShortsMediaAdmissionService,
  ],
  exports: [
    ShortsRateService,
    ShortsUploadAdmissionService,
    ShortsMediaAdmissionService,
    SHORTS_RATE_CONFIG,
  ],
})
export class ShortsRateModule {}
