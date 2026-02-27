import { ProfileController } from './profile.controller';

describe('ProfileController', () => {
  const getController = (profileXInviteService: any = {}) => {
    const profileReadService = {
      getProfilesByAddresses: jest.fn().mockResolvedValue([]),
    } as any;
    const profileAttestationService = {} as any;
    const controller = new ProfileController(
      profileAttestationService,
      profileReadService,
      profileXInviteService,
    );
    return { controller, profileReadService };
  };

  it('parses addresses query for batch endpoint', async () => {
    const { controller, profileReadService } = getController();

    await controller.getProfiles('ak_1, ak_2', 'false');

    expect(profileReadService.getProfilesByAddresses).toHaveBeenCalledWith(
      ['ak_1', 'ak_2'],
      { includeOnChain: false },
    );
  });

  it('creates invite and returns generated link payload', async () => {
    const profileXInviteService = {
      createInvite: jest.fn().mockResolvedValue({ code: 'abc', invite_link: 'abc' }),
    } as any;
    const { controller } = getController(profileXInviteService);

    await controller.createXInvite({
      inviter_address: 'ak_1',
      challenge_nonce: 'a'.repeat(24),
      challenge_expires_at: '123',
      signature_hex: 'b'.repeat(128),
    } as any);

    expect(profileXInviteService.createInvite).toHaveBeenCalledWith({
      inviterAddress: 'ak_1',
      challengeNonce: 'a'.repeat(24),
      challengeExpiresAt: 123,
      signatureHex: 'b'.repeat(128),
    });
  });

  it('binds invite with challenge proof payload', async () => {
    const profileXInviteService = {
      bindInvite: jest.fn().mockResolvedValue({ status: 'bound' }),
    } as any;
    const { controller } = getController(profileXInviteService);

    await controller.bindXInvite('abc123def456', {
      invitee_address: 'ak_2',
      challenge_nonce: 'c'.repeat(24),
      challenge_expires_at: '456',
      signature_hex: 'd'.repeat(128),
    } as any);

    expect(profileXInviteService.bindInvite).toHaveBeenCalledWith({
      code: 'abc123def456',
      inviteeAddress: 'ak_2',
      challengeNonce: 'c'.repeat(24),
      challengeExpiresAt: 456,
      signatureHex: 'd'.repeat(128),
    });
  });

  it('creates invite challenge', async () => {
    const profileXInviteService = {
      createChallenge: jest.fn().mockResolvedValue({ nonce: 'n' }),
    } as any;
    const { controller } = getController(profileXInviteService);

    await controller.createXInviteChallenge({
      address: 'ak_2',
      purpose: 'bind',
      code: 'abc123def456',
    } as any);

    expect(profileXInviteService.createChallenge).toHaveBeenCalledWith({
      address: 'ak_2',
      purpose: 'bind',
      code: 'abc123def456',
    });
  });

  it('gets invite progress', async () => {
    const profileXInviteService = {
      getProgress: jest.fn().mockResolvedValue({ verified_friends_count: 1 }),
    } as any;
    const { controller } = getController(profileXInviteService);

    await controller.getXInviteProgress('ak_2');
    expect(profileXInviteService.getProgress).toHaveBeenCalledWith('ak_2');
  });
});
