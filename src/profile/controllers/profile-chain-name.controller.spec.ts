import { ProfileChainNameController } from './profile-chain-name.controller';

describe('ProfileChainNameController', () => {
  const getController = (overrides?: { profileChainNameService?: any }) => {
    const profileChainNameService =
      overrides?.profileChainNameService || ({} as any);
    const controller = new ProfileChainNameController(profileChainNameService);
    return { controller, profileChainNameService };
  };

  it('creates a chain name challenge', async () => {
    const profileChainNameService = {
      createChallenge: jest.fn().mockResolvedValue({ nonce: 'n' }),
    } as any;
    const { controller } = getController({ profileChainNameService });

    await controller.createChallenge({
      address: 'ak_1',
    } as any);

    expect(profileChainNameService.createChallenge).toHaveBeenCalledWith(
      'ak_1',
    );
  });

  it('verifies challenge proof before starting a claim', async () => {
    const profileChainNameService = {
      requestChainName: jest.fn().mockResolvedValue({ status: 'ok' }),
    } as any;
    const { controller } = getController({ profileChainNameService });

    await controller.requestChainName({
      address: 'ak_1',
      name: 'myuniquename123',
      challenge_nonce: 'a'.repeat(24),
      challenge_expires_at: '123',
      signature_hex: 'b'.repeat(128),
    } as any);

    expect(profileChainNameService.requestChainName).toHaveBeenCalledWith({
      address: 'ak_1',
      name: 'myuniquename123',
      challengeNonce: 'a'.repeat(24),
      challengeExpiresAt: 123,
      signatureHex: 'b'.repeat(128),
    });
  });

  it('gets claim status by address', async () => {
    const profileChainNameService = {
      getClaimStatus: jest.fn().mockResolvedValue({ status: 'pending' }),
    } as any;
    const { controller } = getController({ profileChainNameService });

    await controller.getChainNameClaimStatus('ak_1');

    expect(profileChainNameService.getClaimStatus).toHaveBeenCalledWith('ak_1');
  });
});
