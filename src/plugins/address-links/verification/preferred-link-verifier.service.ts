import { BadRequestException, Injectable } from '@nestjs/common';
import { ClaimPreferredLinkDto } from '../dto/preferred/claim-preferred-link.dto';
import { SubmitPreferredLinkDto } from '../dto/preferred/submit-preferred-link.dto';
import { SubmitPreferredUnlinkDto } from '../dto/preferred/submit-preferred-unlink.dto';
import {
  ADDRESS_LINK_VERIFICATION_TTL_SECONDS,
  PREFERRED_AENS_NAME_PROVIDER,
} from '../address-links.constants';
import { VerifiedClaim } from './link-verifier.interface';
import {
  createVerificationToken,
  parseVerificationToken,
  VerificationTokenPayload,
} from './verification-token.util';

interface PreferredTokenPayload extends VerificationTokenPayload {
  principal: string;
}

const CHAIN_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.chain$/;

@Injectable()
export class PreferredLinkVerifierService {
  async verifyClaim(dto: ClaimPreferredLinkDto): Promise<VerifiedClaim> {
    const value = this.normalizeChainName(dto.value);
    const expiry = Date.now() + ADDRESS_LINK_VERIFICATION_TTL_SECONDS * 1000;
    const verificationToken = createVerificationToken<PreferredTokenPayload>({
      address: dto.address,
      provider: PREFERRED_AENS_NAME_PROVIDER,
      value,
      principal: value,
      expiry,
    });

    return { value, verificationToken };
  }

  async verifySubmit(dto: SubmitPreferredLinkDto): Promise<void> {
    const value = this.normalizeChainName(dto.value);
    const payload = parseVerificationToken<PreferredTokenPayload>(
      dto.verification_token,
    );

    if (Date.now() > payload.expiry) {
      throw new BadRequestException('Verification token has expired');
    }
    if (payload.address !== dto.address) {
      throw new BadRequestException('Verification token address mismatch');
    }
    if (payload.provider !== PREFERRED_AENS_NAME_PROVIDER) {
      throw new BadRequestException('Verification token provider mismatch');
    }
    if (payload.value !== value || payload.principal !== value) {
      throw new BadRequestException('Verification token value mismatch');
    }
  }

  verifyUnlinkPrincipal(dto: SubmitPreferredUnlinkDto): string {
    return this.normalizeChainName(dto.value);
  }

  normalizeChainName(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      throw new BadRequestException('AENS name must not be empty');
    }
    if (normalized.length > 200) {
      throw new BadRequestException(
        'AENS name must be 200 characters or fewer',
      );
    }
    if (normalized.includes(':')) {
      throw new BadRequestException('AENS name must not contain ":"');
    }
    if (!CHAIN_NAME_PATTERN.test(normalized)) {
      throw new BadRequestException(
        'AENS name must be a valid .chain name (e.g. hero.chain)',
      );
    }
    return normalized;
  }
}
