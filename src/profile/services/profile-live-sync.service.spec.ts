import { ProfileLiveSyncService } from './profile-live-sync.service';

describe('ProfileLiveSyncService', () => {
  const setup = (configured = true) => {
    const unsubscribe = jest.fn();
    const websocketService = {
      subscribeForTransactionsUpdates: jest.fn().mockReturnValue(unsubscribe),
    } as any;
    const profileIndexerService = {
      refreshAddress: jest.fn().mockResolvedValue(undefined),
    } as any;
    const profileContractService = {
      isConfigured: jest.fn().mockReturnValue(configured),
      getContractAddress: jest.fn().mockReturnValue('ct_profile'),
      decodeEvents: jest.fn().mockResolvedValue([]),
    } as any;
    const service = new ProfileLiveSyncService(
      websocketService,
      profileIndexerService,
      profileContractService,
    );
    return {
      service,
      websocketService,
      profileIndexerService,
      profileContractService,
      unsubscribe,
    };
  };

  it('subscribes on module init when configured', async () => {
    const { service, websocketService } = setup(true);
    service.onModuleInit();
    expect(websocketService.subscribeForTransactionsUpdates).toHaveBeenCalledTimes(
      1,
    );
  });

  it('does not subscribe when contract is not configured', async () => {
    const { service, websocketService } = setup(false);
    service.onModuleInit();
    expect(websocketService.subscribeForTransactionsUpdates).not.toHaveBeenCalled();
  });

  it('refreshes profile cache for matching live profile mutation tx', async () => {
    const { service, websocketService, profileIndexerService } = setup(true);
    service.onModuleInit();
    const callback = websocketService.subscribeForTransactionsUpdates.mock
      .calls[0][0];

    callback({
      hash: 'th_1',
      microTime: 123,
      tx: {
        contractId: 'ct_profile',
        function: 'set_profile',
        callerId: 'ak_1',
      },
    });
    // flush async callback chain
    await Promise.resolve();
    await Promise.resolve();

    expect(profileIndexerService.refreshAddress).toHaveBeenCalledWith(
      'ak_1',
      '123',
    );
  });

  it('ignores duplicate transaction hashes', async () => {
    const { service, websocketService, profileIndexerService } = setup(true);
    service.onModuleInit();
    const callback = websocketService.subscribeForTransactionsUpdates.mock
      .calls[0][0];
    const tx = {
      hash: 'th_dup',
      microTime: 999,
      tx: {
        contractId: 'ct_profile',
        function: 'set_profile',
        callerId: 'ak_dup',
      },
    };

    callback(tx);
    callback(tx);
    await Promise.resolve();
    await Promise.resolve();

    expect(profileIndexerService.refreshAddress).toHaveBeenCalledTimes(1);
  });

  it('refreshes auto-renamed loser address from decoded events', async () => {
    const { service, websocketService, profileIndexerService, profileContractService } =
      setup(true);
    profileContractService.decodeEvents.mockResolvedValue([
      {
        name: 'CustomNameAutoRenamed',
        args: ['ak_loser', 'old|new'],
      },
    ]);

    service.onModuleInit();
    const callback = websocketService.subscribeForTransactionsUpdates.mock
      .calls[0][0];

    callback({
      hash: 'th_chain_1',
      microTime: 321,
      tx: {
        contractId: 'ct_profile',
        function: 'set_chain_name',
        callerId: 'ak_winner',
        log: [{ topics: ['t1'], data: 'cb_x' }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(profileContractService.decodeEvents).toHaveBeenCalledTimes(1);
    expect(profileIndexerService.refreshAddress).toHaveBeenCalledWith(
      'ak_winner',
      '321',
    );
    expect(profileIndexerService.refreshAddress).toHaveBeenCalledWith(
      'ak_loser',
      '321',
    );
  });

  it('uses caller as signer for pay-for payloads', async () => {
    const { service, websocketService, profileIndexerService } = setup(true);
    service.onModuleInit();
    const callback = websocketService.subscribeForTransactionsUpdates.mock
      .calls[0][0];

    callback({
      hash: 'th_payfor_1',
      microTime: 456,
      tx: {
        contractId: 'ct_profile',
        function: 'set_profile_full',
        callerId: 'ak_real_user',
        payerId: 'ak_team_payer',
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(profileIndexerService.refreshAddress).toHaveBeenCalledWith(
      'ak_real_user',
      '456',
    );
    expect(profileIndexerService.refreshAddress).not.toHaveBeenCalledWith(
      'ak_team_payer',
      '456',
    );
  });

  it('unwraps nested PayingForTx payload shape from middleware', async () => {
    const { service, websocketService, profileIndexerService } = setup(true);
    service.onModuleInit();
    const callback = websocketService.subscribeForTransactionsUpdates.mock
      .calls[0][0];

    callback({
      hash: 'th_payfor_nested_1',
      microTime: 789,
      tx: {
        fee: '100',
        payerId: 'ak_team_payer',
        tx: {
          signatures: ['sg_inner'],
          tx: {
            contractId: 'ct_profile',
            function: 'set_profile_full',
            callerId: 'ak_nested_user',
            log: [],
          },
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(profileIndexerService.refreshAddress).toHaveBeenCalledWith(
      'ak_nested_user',
      '789',
    );
    expect(profileIndexerService.refreshAddress).not.toHaveBeenCalledWith(
      'ak_team_payer',
      '789',
    );
  });
});

