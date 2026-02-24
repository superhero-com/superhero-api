import { OAuthService } from '@/affiliation/services/oauth.service';
import { ProfileAttestationService } from './profile-attestation.service';

describe('ProfileAttestationService', () => {
  const oauthServiceMock = {} as OAuthService;
  const service = new ProfileAttestationService(oauthServiceMock);

  it('normalizes names for uniqueness', () => {
    expect(service.normalizeName('  Alice_Dev  ')).toBe('alice_dev');
  });

  it('builds deterministic attestation message', () => {
    const message = service.createAttestationMessage(
      'ak_test_address',
      'alice',
      1700000000,
      'nonce123',
    );
    expect(message).toBe(
      'profile_x_attestation:ak_test_address:alice:1700000000:nonce123',
    );
  });
});
