import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  ProfileXVerificationAttempt,
  XVerificationAttemptOutcome,
  XVerificationAttemptSource,
} from '../entities/profile-x-verification-attempt.entity';

export interface RecordAttemptInput {
  address: string;
  source: XVerificationAttemptSource;
  outcome: XVerificationAttemptOutcome;
  xUsername?: string | null;
  errorCode?: string | null;
  detail?: string | null;
}

/**
 * Writes the X verification attempt history.
 *
 * The contract that matters: **recording an attempt must never affect the
 * attempt**. This table exists to explain failures, so a fault in it turning
 * into a user-visible failure would be the exact opposite of the point. Every
 * write is swallowed and logged, and callers are not expected to await it for
 * correctness.
 */
@Injectable()
export class ProfileXVerificationAttemptService {
  private readonly logger = new Logger(ProfileXVerificationAttemptService.name);

  /** Matches the column; a provider message must not bloat the row. */
  private static readonly MAX_DETAIL_LENGTH = 500;

  constructor(
    @InjectRepository(ProfileXVerificationAttempt)
    private readonly attemptRepository: Repository<ProfileXVerificationAttempt>,
  ) {}

  async record(input: RecordAttemptInput): Promise<void> {
    try {
      await this.attemptRepository.insert({
        address: input.address,
        source: input.source,
        outcome: input.outcome,
        x_username: input.xUsername ?? null,
        error_code: input.errorCode ?? null,
        detail: ProfileXVerificationAttemptService.truncate(input.detail),
      });
    } catch (error) {
      // Deliberately swallowed. A verification that worked must not be reported
      // as failed because we could not write its audit row.
      this.logger.warn(
        `[x-verification-attempt] could not record ${input.outcome} for ${input.address}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private static truncate(detail: string | null | undefined): string | null {
    if (!detail) return null;
    const trimmed = detail.trim();
    if (!trimmed) return null;
    return trimmed.length > ProfileXVerificationAttemptService.MAX_DETAIL_LENGTH
      ? trimmed.slice(0, ProfileXVerificationAttemptService.MAX_DETAIL_LENGTH)
      : trimmed;
  }
}
