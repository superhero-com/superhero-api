import { ProfileController } from './profile.controller';

describe('ProfileController', () => {
  it('parses addresses query for batch endpoint', async () => {
    const profileReadService = {
      getProfilesByAddresses: jest.fn().mockResolvedValue([]),
    } as any;
    const profileAttestationService = {} as any;
    const controller = new ProfileController(
      profileAttestationService,
      profileReadService,
    );

    await controller.getProfiles('ak_1, ak_2', 'false');

    expect(profileReadService.getProfilesByAddresses).toHaveBeenCalledWith(
      ['ak_1', 'ak_2'],
      { includeOnChain: false },
    );
  });
});
