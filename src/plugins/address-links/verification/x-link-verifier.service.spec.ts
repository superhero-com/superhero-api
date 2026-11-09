import { BadRequestException } from '@nestjs/common';
import crypto from 'crypto';
import { OAuthService } from '@/affiliation/services/oauth.service';
import { ADDRESS_LINK_VERIFICATION_TTL_SECONDS } from '../address-links.constants';
import { ClaimXLinkDto } from '../dto/x/claim-x-link.dto';
import { BioLinkVerifierService } from './bio-link-verifier.service';
import { parseVerificationToken } from './verification-token.util';
import { XLinkVerifierService } from './x-link-verifier.service';

const ADDRESS = 'ak_alice';
const OTHER_ADDRESS = 'ak_mallory';
const NOW = 1_800_000_000_000;
const TTL_MS = ADDRESS_LINK_VERIFICATION_TTL_SECONDS * 1000;
const CODE_CLAIM: ClaimXLinkDto = {
  address: ADDRESS,
  x_code: 'oauth-code',
  x_code_verifier: 'pkce-verifier',
  x_redirect_uri: 'https://superhero.com/x/callback',
};

describe('XLinkVerifierService', () => {
  let oauthService: {
    exchangeXCodeForAccessToken: jest.Mock;
    verifyAccessToken: jest.Mock;
  };
  let verifier: XLinkVerifierService;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    oauthService = {
      exchangeXCodeForAccessToken: jest.fn().mockResolvedValue('x-token'),
      verifyAccessToken: jest.fn().mockResolvedValue({
        id: '42',
        name: 'Alice',
        email: '',
        provider: 'x',
        username: 'Alice_X',
      }),
    };
    verifier = new XLinkVerifierService(
      oauthService as unknown as OAuthService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const submitDto = (verificationToken: string, overrides = {}) => ({
    address: ADDRESS,
    value: 'alice_x',
    nonce: 0,
    signature: 'a'.repeat(128),
    verification_token: verificationToken,
    ...overrides,
  });

  describe('verifyClaim', () => {
    it('binds the handle X returns for the exchanged code to the address', async () => {
      const claim = await verifier.verifyClaim(ADDRESS, CODE_CLAIM);

      expect(oauthService.exchangeXCodeForAccessToken).toHaveBeenCalledWith(
        'oauth-code',
        'pkce-verifier',
        'https://superhero.com/x/callback',
      );
      expect(oauthService.verifyAccessToken).toHaveBeenCalledWith(
        'x',
        'x-token',
      );
      expect(claim.value).toBe('alice_x');
      expect(parseVerificationToken(claim.verificationToken!)).toEqual({
        address: ADDRESS,
        provider: 'x',
        value: 'alice_x',
        expiry: NOW + TTL_MS,
      });
    });

    it('issues no token when the code exchange fails', async () => {
      oauthService.exchangeXCodeForAccessToken.mockRejectedValue(
        new BadRequestException('Failed to exchange X authorization code'),
      );

      await expect(verifier.verifyClaim(ADDRESS, CODE_CLAIM)).rejects.toThrow(
        'Failed to exchange X authorization code',
      );
      expect(oauthService.verifyAccessToken).not.toHaveBeenCalled();
    });

    it('issues no token when X rejects the access token', async () => {
      oauthService.verifyAccessToken.mockRejectedValue(
        new BadRequestException('Invalid or expired X access token'),
      );

      await expect(verifier.verifyClaim(ADDRESS, CODE_CLAIM)).rejects.toThrow(
        'Invalid or expired X access token',
      );
    });

    it('never falls back to the display name when X sends no username', async () => {
      oauthService.verifyAccessToken.mockResolvedValue({
        id: '42',
        name: 'elonmusk',
        email: '',
        provider: 'x',
      });

      await expect(verifier.verifyClaim(ADDRESS, CODE_CLAIM)).rejects.toThrow(
        'Unable to extract X username from OAuth profile',
      );
    });
  });

  describe('verifySubmit', () => {
    it('accepts the token issued for the same address and handle', async () => {
      const claim = await verifier.verifyClaim(ADDRESS, CODE_CLAIM);

      await expect(
        verifier.verifySubmit(submitDto(claim.verificationToken!)),
      ).resolves.toBeUndefined();
    });

    it('accepts the token up to the end of its TTL and not after', async () => {
      const claim = await verifier.verifyClaim(ADDRESS, CODE_CLAIM);
      const dto = submitDto(claim.verificationToken!);

      jest.spyOn(Date, 'now').mockReturnValue(NOW + TTL_MS);
      await expect(verifier.verifySubmit(dto)).resolves.toBeUndefined();

      jest.spyOn(Date, 'now').mockReturnValue(NOW + TTL_MS + 1);
      await expect(verifier.verifySubmit(dto)).rejects.toThrow(
        'Verification token has expired',
      );
    });

    it('refuses a token issued to another address', async () => {
      const claim = await verifier.verifyClaim(ADDRESS, CODE_CLAIM);

      await expect(
        verifier.verifySubmit(
          submitDto(claim.verificationToken!, { address: OTHER_ADDRESS }),
        ),
      ).rejects.toThrow('Verification token address mismatch');
    });

    it.each(['bob', 'Alice_X'])(
      'refuses a token issued for another handle (%s)',
      async (value) => {
        const claim = await verifier.verifyClaim(ADDRESS, CODE_CLAIM);

        await expect(
          verifier.verifySubmit(submitDto(claim.verificationToken!, { value })),
        ).rejects.toThrow('Verification token value mismatch');
      },
    );

    it('refuses a token minted by an unverified provider for the same value', async () => {
      // Anyone can get a bio token for any text, so a bio token naming a
      // handle must not pass as proof of that handle.
      const bioClaim = await new BioLinkVerifierService().verifyClaim({
        address: ADDRESS,
        value: 'alice_x',
      });

      await expect(
        verifier.verifySubmit(submitDto(bioClaim.verificationToken!)),
      ).rejects.toThrow('Verification token provider mismatch');
    });

    it('refuses a token whose payload was edited after signing', async () => {
      const claim = await verifier.verifyClaim(ADDRESS, CODE_CLAIM);
      const raw = Buffer.from(claim.verificationToken!, 'base64url').toString(
        'utf-8',
      );
      const edited = Buffer.from(
        raw.replace('"value":"alice_x"', '"value":"elon"'),
        'utf-8',
      ).toString('base64url');

      await expect(
        verifier.verifySubmit(submitDto(edited, { value: 'elon' })),
      ).rejects.toThrow('Invalid verification token signature');
    });

    it('refuses a token signed with another key', async () => {
      const data = JSON.stringify({
        address: ADDRESS,
        provider: 'x',
        value: 'elon',
        expiry: NOW + TTL_MS,
      });
      const hmac = crypto
        .createHmac('sha256', 'attacker-key')
        .update(data)
        .digest('hex');
      const forged = Buffer.from(`${data}.${hmac}`, 'utf-8').toString(
        'base64url',
      );

      await expect(
        verifier.verifySubmit(submitDto(forged, { value: 'elon' })),
      ).rejects.toThrow('Invalid verification token signature');
    });
  });
});
