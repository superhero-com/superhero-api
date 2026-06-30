import { BadRequestException } from '@nestjs/common';
import { SiteLinkVerifierService } from './site-link-verifier.service';

describe('SiteLinkVerifierService', () => {
  const address = 'ak_2a5f9b9b4b0a8c2e5bc087ecbfc0ef6a1234567890abcd';
  let verifier: SiteLinkVerifierService;

  beforeEach(() => {
    verifier = new SiteLinkVerifierService();
  });

  it('normalizes https URLs and creates a matching verification token', async () => {
    const claim = await verifier.verifyClaim({
      address,
      value: '  HTTPS://Example.com/blog/  ',
    });

    expect(claim.value).toBe('example.com/blog');
    expect(claim.verificationToken).toBeTruthy();

    await expect(
      verifier.verifySubmit({
        address,
        value: 'https://example.com/blog',
        nonce: 0,
        signature: 'a'.repeat(128),
        verification_token: claim.verificationToken!,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects values with a port', async () => {
    await expect(
      verifier.verifyClaim({
        address,
        value: 'https://example.com:8080',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid hostnames', async () => {
    await expect(
      verifier.verifyClaim({
        address,
        value: 'not a valid site',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects submit values that do not match the token', async () => {
    const claim = await verifier.verifyClaim({
      address,
      value: 'example.com',
    });

    await expect(
      verifier.verifySubmit({
        address,
        value: 'other.com',
        nonce: 0,
        signature: 'a'.repeat(128),
        verification_token: claim.verificationToken!,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
