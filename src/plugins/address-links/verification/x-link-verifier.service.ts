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
    // Only a code exchanged with our client secret proves the user signed in
    // through our app; a bare access token could come from any X app.
    const accessToken = await this.oauthService.exchangeXCodeForAccessToken(
      dto.x_code,
      dto.x_code_verifier,
      dto.x_redirect_uri,
    );

    const oauthUser = await this.oauthService.verifyAccessToken(
      'x',
      accessToken,
    );
    // Never the display name: anyone can set it to someone else's handle.
    const value = oauthUser.username?.trim().toLowerCase();
    if (!value) {
      throw new BadRequestException(
        'Unable to extract X username from OAuth profile',
      );
    }

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
}
