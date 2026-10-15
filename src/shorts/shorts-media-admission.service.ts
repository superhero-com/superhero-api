import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SHORTS_RATE_CONFIG, ShortsRateConfig } from './shorts-rate.config';
import { ShortsChainService } from './shorts-chain.service';
import {
  ShortsAdmissionLimits,
  ShortsTransferAdmissionService,
} from './shorts-transfer-admission.service';

export const SHORTS_MEDIA_ADMISSION_LIMITS = Symbol(
  'SHORTS_MEDIA_ADMISSION_LIMITS',
);

export class ShortsMediaUnavailableError extends ServiceUnavailableException {
  constructor() {
    super(
      'Video processing is busy or temporarily unavailable. Please retry shortly.',
    );
  }
}

/** Separate shared budget for hosted preview, scan and recovery transfers. */
@Injectable()
export class ShortsMediaAdmissionService extends ShortsTransferAdmissionService {
  constructor(
    @Inject(SHORTS_RATE_CONFIG) config: ShortsRateConfig,
    chain: ShortsChainService,
    @Optional()
    @Inject(SHORTS_MEDIA_ADMISSION_LIMITS)
    limits?: ShortsAdmissionLimits,
  ) {
    super(
      config,
      chain,
      limits || {
        capacity: Number(process.env.SHORTS_SHARED_CONCURRENT_MEDIA ?? 2),
        leaseMs: 30000,
        renewMs: 10000,
      },
      'media',
    );
  }
  override async acquire(actor: string) {
    try {
      return await super.acquire(actor);
    } catch {
      throw new ShortsMediaUnavailableError();
    }
  }
}
