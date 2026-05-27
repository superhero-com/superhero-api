import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import crypto from 'crypto';
import { ClaimBioLinkDto } from '../dto/bio/claim-bio-link.dto';
import { SubmitBioLinkDto } from '../dto/bio/submit-bio-link.dto';
import {
  ADDRESS_LINK_SECRET_KEY,
  ADDRESS_LINK_VERIFICATION_TTL_SECONDS,
} from '../address-links.constants';
import { VerifiedClaim } from './link-verifier.interface';

interface VerificationTokenPayload {
  address: string;
  provider: string;
  value: string;
  expiry: number;
}

@Injectable()
export class BioLinkVerifierService {
  private readonly logger = new Logger(BioLinkVerifierService.name);

  async verifyClaim(dto: ClaimBioLinkDto): Promise<VerifiedClaim> {
    const value = this.normalizeBio(dto.value);
    const expiry = Date.now() + ADDRESS_LINK_VERIFICATION_TTL_SECONDS * 1000;
    const verificationToken = this.createVerificationToken({
      address: dto.address,
      provider: 'bio',
      value,
      expiry,
    });

    return { value, verificationToken };
  }

  async verifySubmit(dto: SubmitBioLinkDto): Promise<void> {
    const value = this.normalizeBio(dto.value);
    const payload = this.parseVerificationToken(dto.verification_token);

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
