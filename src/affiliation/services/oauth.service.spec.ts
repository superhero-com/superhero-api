import { BadRequestException } from '@nestjs/common';
import { OAuthService } from './oauth.service';

jest.mock('@/configs/social', () => ({
  GITHUB_CLIENT_ID: 'github-client-id',
  GITHUB_CLIENT_SECRET: 'github-client-secret',
  X_CLIENT_ID: 'x-client-id',
  X_CLIENT_SECRET: 'x-client-secret',
}));

describe('OAuthService', () => {
  let service: OAuthService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new OAuthService();
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  describe('exchangeXCodeForAccessToken', () => {
    it('throws BadRequestException when the network request fails', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));

      await expect(
        service.exchangeXCodeForAccessToken('code', 'verifier', 'redirect'),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns the access token on success', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: 'token-123' }),
        headers: { get: () => null },
      });

      const token = await service.exchangeXCodeForAccessToken(
        'code',
        'verifier',
        'redirect',
      );

      expect(token).toBe('token-123');
    });
  });
});
