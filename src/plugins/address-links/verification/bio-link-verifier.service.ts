import { BadRequestException, Injectable } from '@nestjs/common';
import { ClaimBioLinkDto } from '../dto/bio/claim-bio-link.dto';
import { SubmitBioLinkDto } from '../dto/bio/submit-bio-link.dto';
import { ADDRESS_LINK_VERIFICATION_TTL_SECONDS } from '../address-links.constants';
import { VerifiedClaim } from './link-verifier.interface';
import {
  createVerificationToken,
  parseVerificationToken,
} from './verification-token.util';

@Injectable()
export class BioLinkVerifierService {
  async verifyClaim(dto: ClaimBioLinkDto): Promise<VerifiedClaim> {
    const value = this.normalizeBio(dto.value);
    const expiry = Date.now() + ADDRESS_LINK_VERIFICATION_TTL_SECONDS * 1000;
    const verificationToken = createVerificationToken({
      address: dto.address,
      provider: 'bio',
      value,
      expiry,
    });

    return { value, verificationToken };
  }

  async verifySubmit(dto: SubmitBioLinkDto): Promise<void> {
    const value = this.normalizeBio(dto.value);
    const payload = parseVerificationToken(dto.verification_token);

    if (Date.now() > payload.expiry) {
      throw new BadRequestException('Verification token has expired');
    }
    if (payload.address !== dto.address) {
      throw new BadRequestException('Verification token address mismatch');
    }
    if (payload.provider !== 'bio') {
      throw new BadRequestException('Verification token provider mismatch');
    }
    if (payload.value !== value) {
      throw new BadRequestException('Verification token value mismatch');
    }
  }

  private normalizeBio(value: string): string {
    const normalized = value.trim();
    if (normalized.length === 0) {
      throw new BadRequestException('Bio must not be empty');
    }
    if (normalized.length > 200) {
      throw new BadRequestException('Bio must be 200 characters or fewer');
    }
    if (normalized.includes(':')) {
      throw new BadRequestException('Bio must not contain ":"');
    }
    return normalized;
  }
}
