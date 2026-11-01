import { BadRequestException } from '@nestjs/common';
import {
  AvatarLinkVerifierService,
  avatarLinkToUrl,
} from './avatar-link-verifier.service';

describe('AvatarLinkVerifierService', () => {
  const address = 'ak_2a5f9b9b4b0a8c2e5bc087ecbfc0ef6a1234567890abcd';
  let verifier: AvatarLinkVerifierService;

  beforeEach(() => {
    verifier = new AvatarLinkVerifierService();
  });

  it('stores an https image URL without the protocol and accepts the token', async () => {
    const claim = await verifier.verifyClaim({
      address,
      value: '  https://CDN.Example.com/Users/Me.PNG  ',
    });

    expect(claim.value).toBe('cdn.example.com/Users/Me.PNG');
    expect(claim.verificationToken).toBeTruthy();

    await expect(
      verifier.verifySubmit({
        address,
        value: 'https://cdn.example.com/Users/Me.PNG',
        nonce: 0,
        signature: 'a'.repeat(128),
        verification_token: claim.verificationToken!,
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps a query string and drops a fragment', () => {
    expect(verifier.normalizeAvatar('https://example.com/a.webp?v=2#x')).toBe(
      'example.com/a.webp?v=2',
    );
  });

  it('accepts known image hosts without an extension', () => {
    expect(verifier.normalizeAvatar('https://i.imgur.com/abc123')).toBe(
      'i.imgur.com/abc123',
    );
  });

  it.each([
    ['empty', '   '],
    ['plain http', 'http://example.com/me.png'],
    ['a port', 'https://example.com:8443/me.png'],
    ['no path', 'https://example.com'],
    ['not an image', 'https://example.com/page.html'],
    ['a javascript url', 'javascript:alert(1)'],
    ['too long', `https://example.com/${'a'.repeat(200)}.png`],
  ])('rejects %s', async (_label, value) => {
    await expect(
      verifier.verifyClaim({ address, value }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a token issued for another provider', async () => {
    const claim = await verifier.verifyClaim({
      address,
      value: 'https://example.com/me.png',
    });
    await expect(
      verifier.verifySubmit({
        address: 'ak_other',
        value: 'https://example.com/me.png',
        nonce: 0,
        signature: 'a'.repeat(128),
        verification_token: claim.verificationToken!,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('turns the stored value back into an https URL', () => {
    expect(avatarLinkToUrl('example.com/me.png')).toBe(
      'https://example.com/me.png',
    );
    expect(avatarLinkToUrl('')).toBeNull();
    expect(avatarLinkToUrl(undefined)).toBeNull();
  });
});
