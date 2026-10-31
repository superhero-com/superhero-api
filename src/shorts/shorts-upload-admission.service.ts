import { Inject, Injectable, Optional } from '@nestjs/common';
import { SHORTS_RATE_CONFIG, ShortsRateConfig } from './shorts-rate.config';
import { ShortsChainService } from './shorts-chain.service';
import {
  ShortsAdmissionLimits,
  ShortsTransferAdmissionService,
} from './shorts-transfer-admission.service';
export type {
  ShortsAdmissionLimits as UploadAdmissionLimits,
  ShortsAdmissionReservation as UploadReservation,
} from './shorts-transfer-admission.service';

export const SHORTS_UPLOAD_ADMISSION_LIMITS = Symbol(
  'SHORTS_UPLOAD_ADMISSION_LIMITS',
);

/** Shared capacity from body parsing through private storage and metadata. */
@Injectable()
export class ShortsUploadAdmissionService extends ShortsTransferAdmissionService {
  constructor(
    @Inject(SHORTS_RATE_CONFIG) config: ShortsRateConfig,
    chain: ShortsChainService,
    @Optional()
    @Inject(SHORTS_UPLOAD_ADMISSION_LIMITS)
    limits?: ShortsAdmissionLimits,
  ) {
    super(
      config,
      chain,
      limits || {
        capacity: Number(process.env.SHORTS_SHARED_CONCURRENT_UPLOADS ?? 4),
        leaseMs: 30000,
        renewMs: 10000,
      },
      'upload',
    );
  }
}
