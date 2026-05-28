import { BadRequestException } from '@nestjs/common';
import { PreferredLinkVerifierService } from './preferred-link-verifier.service';

describe('PreferredLinkVerifierService', () => {
  const address = 'ak_2a5f9b9b4b0a8c2e5bc087ecbfc0ef6a1234567890abcd';
  let verifier: PreferredLinkVerifierService;

  beforeEach(() => {
    verifier = new PreferredLinkVerifierService();
  });

  it('normalizes AENS names and creates a matching verification token', async () => {
    const claim = await verifier.verifyClaim({
      address,
      value: '  Hero.CHAIN  ',
    });

    expect(claim.value).toBe('hero.chain');
    expect(claim.verificationToken).toBeTruthy();

    await expect(
      verifier.verifySubmit({
        address,
        value: 'hero.chain',
        nonce: 0,
        signature: 'a'.repeat(128),
        verification_token: claim.verificationToken!,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects names that are not .chain principals', async () => {
    await expect(
      verifier.verifyClaim({
        address,
        value: 'Hero Name',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects AENS names longer than the contract value limit', async () => {
    await expect(
      verifier.verifyClaim({
        address,
        value: `${'a'.repeat(194)}.chain`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects submit values that do not match the token', async () => {
    const claim = await verifier.verifyClaim({
      address,
      value: 'hero.chain',
    });

    await expect(
      verifier.verifySubmit({
        address,
        value: 'other.chain',
        nonce: 0,
        signature: 'a'.repeat(128),
        verification_token: claim.verificationToken!,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates unlink principal values', () => {
    expect(
      verifier.verifyUnlinkPrincipal({
        address,
        value: 'hero.chain',
        nonce: 1,
        signature: 'a'.repeat(128),
      }),
    ).toBe('hero.chain');
  });
});
