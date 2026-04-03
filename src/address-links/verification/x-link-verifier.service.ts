import { OAuthService } from '@/affiliation/services/oauth.service';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import crypto from 'crypto';
import { ClaimLinkDto } from '../dto/claim-link.dto';
import { SubmitLinkDto } from '../dto/submit-link.dto';
import {
  ADDRESS_LINK_SECRET_KEY,
  ADDRESS_LINK_VERIFICATION_TTL_SECONDS,
} from '../address-links.constants';
import { LinkVerifier, VerifiedClaim } from './link-verifier.interface';

interface VerificationTokenPayload {
  address: string;
  provider: string;
  value: string;
  expiry: number;
}

@Injectable()
export class XLinkVerifierService implements LinkVerifier {
  private readonly logger = new Logger(XLinkVerifierService.name);

  constructor(private readonly oauthService: OAuthService) {}

  async verifyClaim(address: string, dto: ClaimLinkDto): Promise<VerifiedClaim> {
    const accessToken = await this.resolveAccessToken(dto);

    const oauthUser = await this.oauthService.verifyAccessToken('x', accessToken);
    const xUsername = oauthUser.username || oauthUser.name;
    if (!xUsername) {
      throw new BadRequestException(
        'Unable to extract X username from OAuth profile',
      );
    }

    const value = xUsername.trim().toLowerCase();
    const expiry = Date.now() + ADDRESS_LINK_VERIFICATION_TTL_SECONDS * 1000;
    const verificationToken = this.createVerificationToken({
      address,
      provider: 'x',
      value,
      expiry,
    });

    return { value, verificationToken };
  }

  async verifySubmit(dto: SubmitLinkDto, _expectedMessage: string): Promise<void> {
    if (!dto.verification_token) {
      throw new BadRequestException(
        'verification_token is required for X link submission',
      );
    }

    const payload = this.parseVerificationToken(dto.verification_token);

    if (Date.now() > payload.expiry) {
      throw new BadRequestException('Verification token has expired');
    }
    if (payload.address !== dto.address) {
      throw new BadRequestException('Verification token address mismatch');
    }
    if (payload.provider !== dto.provider) {
      throw new BadRequestException('Verification token provider mismatch');
    }
    if (payload.value !== dto.value) {
      throw new BadRequestException('Verification token value mismatch');
    }
  }

  private async resolveAccessToken(dto: ClaimLinkDto): Promise<string> {
    if (dto.x_access_token) {
      return dto.x_access_token;
    }

    if (dto.x_code && dto.x_code_verifier && dto.x_redirect_uri) {
      return this.oauthService.exchangeXCodeForAccessToken(
        dto.x_code,
        dto.x_code_verifier,
        dto.x_redirect_uri,
      );
    }

    throw new BadRequestException(
      'X link requires either x_access_token or x_code + x_code_verifier + x_redirect_uri',
    );
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
