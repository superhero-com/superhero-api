import { BadRequestException, Injectable } from '@nestjs/common';
import { ClaimSiteLinkDto } from '../dto/site/claim-site-link.dto';
import { SubmitSiteLinkDto } from '../dto/site/submit-site-link.dto';
import { ADDRESS_LINK_VERIFICATION_TTL_SECONDS } from '../address-links.constants';
import { VerifiedClaim } from './link-verifier.interface';
import {
  createVerificationToken,
  parseVerificationToken,
} from './verification-token.util';

/** Hostname with optional path; protocol and port are not allowed on-chain. */
const SITE_VALUE_PATTERN =
  /^(localhost|([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+))(?:\/[^\s]*)?$/;

@Injectable()
export class SiteLinkVerifierService {
  async verifyClaim(dto: ClaimSiteLinkDto): Promise<VerifiedClaim> {
    const value = this.normalizeSite(dto.value);
    const expiry = Date.now() + ADDRESS_LINK_VERIFICATION_TTL_SECONDS * 1000;
    const verificationToken = createVerificationToken({
      address: dto.address,
      provider: 'site',
      value,
      expiry,
    });

    return { value, verificationToken };
  }

  async verifySubmit(dto: SubmitSiteLinkDto): Promise<void> {
    const value = this.normalizeSite(dto.value);
    const payload = parseVerificationToken(dto.verification_token);

    if (Date.now() > payload.expiry) {
      throw new BadRequestException('Verification token has expired');
    }
    if (payload.address !== dto.address) {
      throw new BadRequestException('Verification token address mismatch');
    }
    if (payload.provider !== 'site') {
      throw new BadRequestException('Verification token provider mismatch');
    }
    if (payload.value !== value) {
      throw new BadRequestException('Verification token value mismatch');
    }
  }

  normalizeSite(value: string): string {
    let normalized = value.trim();
    if (normalized.length === 0) {
      throw new BadRequestException('Site must not be empty');
    }

    normalized = normalized.replace(/^https?:\/\//i, '');
    normalized = normalized.replace(/^\/\//, '');
    normalized = normalized.split(/[?#]/)[0];
    normalized = normalized.replace(/\/+$/, '');
    normalized = normalized.toLowerCase();

    if (normalized.length === 0) {
      throw new BadRequestException('Site must not be empty');
    }
    if (normalized.length > 200) {
      throw new BadRequestException('Site must be 200 characters or fewer');
    }
    if (normalized.includes(':')) {
      throw new BadRequestException(
        'Site must not contain ":" (omit protocol and port, e.g. example.com)',
      );
    }
    if (!SITE_VALUE_PATTERN.test(normalized)) {
      throw new BadRequestException(
        'Site must be a valid hostname or domain with optional path (e.g. example.com or example.com/blog)',
      );
    }

    return normalized;
  }
}
