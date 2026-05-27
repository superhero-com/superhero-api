import { BadRequestException } from '@nestjs/common';
import { BioLinkVerifierService } from './bio-link-verifier.service';

describe('BioLinkVerifierService', () => {
  const address = 'ak_2a5f9b9b4b0a8c2e5bc087ecbfc0ef6a1234567890abcd';

  it('creates and accepts a verification token for the normalized bio', async () => {
    const verifier = new BioLinkVerifierService();

    const claim = await verifier.verifyClaim({
      address,
      value: '  hello bio  ',
    });

    expect(claim.value).toBe('hello bio');
    expect(claim.verificationToken).toBeTruthy();

    await expect(
      verifier.verifySubmit({
        address,
        value: 'hello bio',
        nonce: 0,
        signature: 'a'.repeat(128),
        verification_token: claim.verificationToken!,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects bios longer than the contract value limit', async () => {
    const verifier = new BioLinkVerifierService();

    await expect(
      verifier.verifyClaim({
        address,
        value: 'a'.repeat(201),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects submit values that do not match the token', async () => {
    const verifier = new BioLinkVerifierService();
    const claim = await verifier.verifyClaim({
      address,
      value: 'hello bio',
    });

    await expect(
      verifier.verifySubmit({
        address,
        value: 'different bio',
        nonce: 0,
        signature: 'a'.repeat(128),
        verification_token: claim.verificationToken!,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
