import { DevicesController } from './devices.controller';

describe('DevicesController', () => {
  let deviceService: any;
  let challengeService: any;
  let controller: DevicesController;

  beforeEach(() => {
    deviceService = {
      register: jest.fn().mockResolvedValue(undefined),
      unregister: jest.fn().mockResolvedValue(undefined),
    };
    challengeService = {
      issue: jest.fn().mockResolvedValue({
        nonce: 'n1',
        expiresAt: new Date(),
      }),
    };
    controller = new DevicesController(deviceService, challengeService);
  });

  it('issues a challenge for the address', async () => {
    const res = await controller.requestChallenge({ address: 'ak_alice' });
    expect(challengeService.issue).toHaveBeenCalledWith('ak_alice');
    expect(res).toMatchObject({ nonce: 'n1' });
  });

  it('registers a device and returns ok', async () => {
    const dto = {
      address: 'ak_alice',
      expoPushToken: 'ExponentPushToken[x]',
      platform: 'ios' as const,
      nonce: 'n1',
      signature: 'sg_ok',
    };
    await expect(controller.register(dto)).resolves.toEqual({ ok: true });
    expect(deviceService.register).toHaveBeenCalledWith(dto);
  });

  it('unregisters a device with a signed unlink challenge', async () => {
    const dto = {
      address: 'ak_alice',
      expoPushToken: 'ExponentPushToken[x]',
      nonce: 'n2',
      signature: 'sg_ok2',
    };
    await expect(controller.unregister(dto)).resolves.toEqual({ ok: true });
    expect(deviceService.unregister).toHaveBeenCalledWith(dto);
  });
});
