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

  it('rejects a verification token that has expired', async () => {
    const verifier = new BioLinkVerifierService();

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const claim = await verifier.verifyClaim({ address, value: 'hello bio' });

    // Advance well past the TTL so the embedded expiry is in the past.
    nowSpy.mockReturnValue(1_000_000 + 10 * 60 * 1000);

    await expect(
      verifier.verifySubmit({
        address,
        value: 'hello bio',
        nonce: 0,
        signature: 'a'.repeat(128),
        verification_token: claim.verificationToken!,
      }),
    ).rejects.toThrow('Verification token has expired');

    nowSpy.mockRestore();
  });

  it('rejects a verification token signed for a different address', async () => {
    const verifier = new BioLinkVerifierService();
    const claim = await verifier.verifyClaim({ address, value: 'hello bio' });

    await expect(
      verifier.verifySubmit({
        address: 'ak_differentaddress00000000000000000000000000000000',
        value: 'hello bio',
        nonce: 0,
        signature: 'a'.repeat(128),
        verification_token: claim.verificationToken!,
      }),
    ).rejects.toThrow('Verification token address mismatch');
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
