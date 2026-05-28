import { BadRequestException, Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { ClaimPreferredLinkDto } from '../dto/preferred/claim-preferred-link.dto';
import { SubmitPreferredLinkDto } from '../dto/preferred/submit-preferred-link.dto';
import { SubmitPreferredUnlinkDto } from '../dto/preferred/submit-preferred-unlink.dto';
import {
  ADDRESS_LINK_SECRET_KEY,
  ADDRESS_LINK_VERIFICATION_TTL_SECONDS,
  PREFERRED_AENS_NAME_PROVIDER,
} from '../address-links.constants';
import { VerifiedClaim } from './link-verifier.interface';

interface VerificationTokenPayload {
  address: string;
  provider: string;
  value: string;
  principal: string;
  expiry: number;
}

const CHAIN_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.chain$/;

@Injectable()
export class PreferredLinkVerifierService {
  async verifyClaim(dto: ClaimPreferredLinkDto): Promise<VerifiedClaim> {
    const value = this.normalizeChainName(dto.value);
    const expiry = Date.now() + ADDRESS_LINK_VERIFICATION_TTL_SECONDS * 1000;
    const verificationToken = this.createVerificationToken({
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
    const payload = this.parseVerificationToken(dto.verification_token);

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

  private createVerificationToken(payload: VerificationTokenPayload): string {
    const data = JSON.stringify(payload);
    const hmac = crypto
      .createHmac('sha256', ADDRESS_LINK_SECRET_KEY)
      .update(data)
      .digest('hex');
    const tokenBytes = Buffer.from(`${data}.${hmac}`, 'utf-8');
    return tokenBytes.toString('base64url');
  }

  private parseVerificationToken(token: string): VerificationTokenPayload {
    let raw: string;
    try {
      raw = Buffer.from(token, 'base64url').toString('utf-8');
    } catch {
      throw new BadRequestException('Invalid verification token encoding');
    }

    const dotIdx = raw.lastIndexOf('.');
    if (dotIdx === -1) {
      throw new BadRequestException('Malformed verification token');
    }

    const data = raw.substring(0, dotIdx);
    const providedHmac = raw.substring(dotIdx + 1);

    const expectedHmac = crypto
      .createHmac('sha256', ADDRESS_LINK_SECRET_KEY)
      .update(data)
      .digest('hex');

    if (
      providedHmac.length !== expectedHmac.length ||
      !crypto.timingSafeEqual(
        Buffer.from(providedHmac, 'hex'),
        Buffer.from(expectedHmac, 'hex'),
      )
    ) {
      throw new BadRequestException('Invalid verification token signature');
    }

    try {
      return JSON.parse(data) as VerificationTokenPayload;
    } catch {
      throw new BadRequestException('Invalid verification token payload');
    }
  }
}
