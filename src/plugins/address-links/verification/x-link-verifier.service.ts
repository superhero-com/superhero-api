import { OAuthService } from '@/affiliation/services/oauth.service';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ClaimXLinkDto } from '../dto/x/claim-x-link.dto';
import { SubmitXLinkDto } from '../dto/x/submit-x-link.dto';
import { ADDRESS_LINK_VERIFICATION_TTL_SECONDS } from '../address-links.constants';
import { VerifiedClaim } from './link-verifier.interface';
import {
  createVerificationToken,
  parseVerificationToken,
} from './verification-token.util';

@Injectable()
export class XLinkVerifierService {
  private readonly logger = new Logger(XLinkVerifierService.name);

  constructor(private readonly oauthService: OAuthService) {}

  async verifyClaim(
    address: string,
    dto: ClaimXLinkDto,
  ): Promise<VerifiedClaim> {
    const accessToken = await this.resolveAccessToken(dto);

    const oauthUser = await this.oauthService.verifyAccessToken(
      'x',
      accessToken,
    );
    const xUsername = oauthUser.username || oauthUser.name;
    if (!xUsername) {
      throw new BadRequestException(
        'Unable to extract X username from OAuth profile',
      );
    }

    const value = xUsername.trim().toLowerCase();
    const expiry = Date.now() + ADDRESS_LINK_VERIFICATION_TTL_SECONDS * 1000;
    const verificationToken = createVerificationToken({
      address,
      provider: 'x',
      value,
      expiry,
    });

    return { value, verificationToken };
  }

  async verifySubmit(dto: SubmitXLinkDto): Promise<void> {
    const payload = parseVerificationToken(dto.verification_token);

    if (Date.now() > payload.expiry) {
      throw new BadRequestException('Verification token has expired');
    }
    if (payload.address !== dto.address) {
      throw new BadRequestException('Verification token address mismatch');
    }
    if (payload.provider !== 'x') {
      throw new BadRequestException('Verification token provider mismatch');
    }
    if (payload.value !== dto.value) {
      throw new BadRequestException('Verification token value mismatch');
    }
  }

  private async resolveAccessToken(dto: ClaimXLinkDto): Promise<string> {
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
}
