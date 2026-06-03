import { PreferencesController } from './preferences.controller';

/**
 * Covers the signature-gated preference-update path: the controller MUST verify
 * (and consume) the signed challenge — bound to the exact preferences body —
 * before any write, and must re-read afterward.
 */
describe('PreferencesController', () => {
  let challenges: any;
  let preferences: any;
  let controller: PreferencesController;

  const prefsList = [
    { id: 'announcement', title: 'A', short_description: 'd', enabled: false },
  ];

  beforeEach(() => {
    challenges = {
      verifyAndConsumeForPreferences: jest.fn().mockResolvedValue(undefined),
    };
    preferences = {
      listFor: jest.fn().mockResolvedValue(prefsList),
      applyPartial: jest.fn().mockResolvedValue(undefined),
    };
    controller = new PreferencesController(challenges, preferences);
  });

  it('verifies the body-bound signature BEFORE writing, then re-reads', async () => {
    const dto = {
      nonce: 'n1',
      signature: 'sg_ok',
      preferences: [{ type: 'announcement', enabled: false }],
    } as any;

    await controller.update('ak_alice', dto);

    expect(challenges.verifyAndConsumeForPreferences).toHaveBeenCalledWith(
      'n1',
      'ak_alice',
      dto.preferences,
      'sg_ok',
    );
    expect(preferences.applyPartial).toHaveBeenCalledWith(
      'ak_alice',
      dto.preferences,
    );
    // verify happened before the write
    const verifyOrder =
      challenges.verifyAndConsumeForPreferences.mock.invocationCallOrder[0];
    const writeOrder = preferences.applyPartial.mock.invocationCallOrder[0];
    expect(verifyOrder).toBeLessThan(writeOrder);
  });

  it('does NOT write when signature verification throws', async () => {
    challenges.verifyAndConsumeForPreferences.mockRejectedValue(
      new Error('Invalid signature'),
    );

    await expect(
      controller.update('ak_alice', {
        nonce: 'n1',
        signature: 'bad',
        preferences: [{ type: 'announcement', enabled: false }],
      } as any),
    ).rejects.toThrow('Invalid signature');

    expect(preferences.applyPartial).not.toHaveBeenCalled();
  });

  it('list is public (no challenge) and returns the merged catalog', async () => {
    await expect(controller.list('ak_alice')).resolves.toEqual(prefsList);
    expect(challenges.verifyAndConsumeForPreferences).not.toHaveBeenCalled();
  });

  it('challenge issuance delegates to the challenge service', async () => {
    challenges.issue = jest
      .fn()
      .mockResolvedValue({ nonce: 'n', expiresAt: new Date() });
    await controller.requestChallenge({ address: 'ak_alice' } as any);
    expect(challenges.issue).toHaveBeenCalledWith('ak_alice');
  });
});
