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
    const profileXVerificationRewardService = {
      sendRewardIfEligible: jest.fn().mockResolvedValue(undefined),
    } as any;
    const service = new ProfileLiveSyncService(
      websocketService,
      profileIndexerService,
      profileContractService,
      profileXVerificationRewardService,
    );
    return {
      service,
      websocketService,
      profileIndexerService,
      profileContractService,
      profileXVerificationRewardService,
      unsubscribe,
    };
  };

  it('subscribes on module init when configured', async () => {
    const { service, websocketService } = setup(true);
    service.onModuleInit();
    expect(
      websocketService.subscribeForTransactionsUpdates,
    ).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe when contract is not configured', async () => {
    const { service, websocketService } = setup(false);
    service.onModuleInit();
    expect(
      websocketService.subscribeForTransactionsUpdates,
    ).not.toHaveBeenCalled();
  });

  it('refreshes profile cache for matching live profile mutation tx', async () => {
    const { service, websocketService, profileIndexerService } = setup(true);
    service.onModuleInit();
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

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

  it('rewards only after successful on-chain x verification tx', async () => {
    const {
      service,
      websocketService,
      profileIndexerService,
      profileXVerificationRewardService,
    } = setup(true);
    service.onModuleInit();
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

    callback({
      hash: 'th_x_verified_1',
      pending: false,
      microTime: 1001,
      tx: {
        contractId: 'ct_profile',
        function: 'set_x_name_with_attestation',
        callerId: 'ak_rewarded_user',
        returnType: 'ok',
        arguments: [{ value: 'AliceOnX' }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      profileXVerificationRewardService.sendRewardIfEligible,
    ).toHaveBeenCalledWith('ak_rewarded_user', 'aliceonx');
    expect(profileIndexerService.refreshAddress).toHaveBeenCalledWith(
      'ak_rewarded_user',
      '1001',
    );
  });

  it('does not reward when x verification tx is pending', async () => {
    const { service, websocketService, profileXVerificationRewardService } =
      setup(true);
    service.onModuleInit();
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

    callback({
      hash: 'th_x_pending_1',
      pending: true,
      microTime: 1002,
      tx: {
        contractId: 'ct_profile',
        function: 'set_x_name_with_attestation',
        callerId: 'ak_pending_user',
        returnType: 'ok',
        arguments: [{ value: 'PendingX' }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      profileXVerificationRewardService.sendRewardIfEligible,
    ).not.toHaveBeenCalled();
  });

  it('rewards when same hash arrives pending first, then confirmed', async () => {
    const { service, websocketService, profileXVerificationRewardService } =
      setup(true);
    service.onModuleInit();
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

    callback({
      hash: 'th_x_pending_then_confirmed_1',
      pending: true,
      microTime: 10021,
      tx: {
        contractId: 'ct_profile',
        function: 'set_x_name_with_attestation',
        callerId: 'ak_pending_then_confirmed',
        returnType: 'ok',
        arguments: [{ value: 'PendingThenConfirmed' }],
      },
    });
    callback({
      hash: 'th_x_pending_then_confirmed_1',
      pending: false,
      microTime: 10022,
      tx: {
        contractId: 'ct_profile',
        function: 'set_x_name_with_attestation',
        callerId: 'ak_pending_then_confirmed',
        returnType: 'ok',
        arguments: [{ value: 'PendingThenConfirmed' }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      profileXVerificationRewardService.sendRewardIfEligible,
    ).toHaveBeenCalledTimes(1);
    expect(
      profileXVerificationRewardService.sendRewardIfEligible,
    ).toHaveBeenCalledWith('ak_pending_then_confirmed', 'pendingthenconfirmed');
  });

  it('does not reprocess hash after pending/confirmed when queue evicts once', async () => {
    const { service, websocketService, profileXVerificationRewardService } =
      setup(true);
    (service as any).maxRecentTxHashes = 2;
    service.onModuleInit();
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

    callback({
      hash: 'th_hash_state_1',
      pending: true,
      microTime: 11001,
      tx: {
        contractId: 'ct_profile',
        function: 'set_x_name_with_attestation',
        callerId: 'ak_hash_state_user',
        returnType: 'ok',
        arguments: [{ value: 'HashStateUser' }],
      },
    });
    callback({
      hash: 'th_hash_state_1',
      pending: false,
      microTime: 11002,
      tx: {
        contractId: 'ct_profile',
        function: 'set_x_name_with_attestation',
        callerId: 'ak_hash_state_user',
        returnType: 'ok',
        arguments: [{ value: 'HashStateUser' }],
      },
    });
    callback({
      hash: 'th_other_hash_1',
      pending: false,
      microTime: 11003,
      tx: {
        contractId: 'ct_profile',
        function: 'set_profile',
        callerId: 'ak_other_user',
      },
    });
    callback({
      hash: 'th_hash_state_1',
      pending: false,
      microTime: 11004,
      tx: {
        contractId: 'ct_profile',
        function: 'set_x_name_with_attestation',
        callerId: 'ak_hash_state_user',
        returnType: 'ok',
        arguments: [{ value: 'HashStateUser' }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      profileXVerificationRewardService.sendRewardIfEligible,
    ).toHaveBeenCalledTimes(1);
  });

  it('does not reward when x verification tx is reverted', async () => {
    const { service, websocketService, profileXVerificationRewardService } =
      setup(true);
    service.onModuleInit();
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

    callback({
      hash: 'th_x_revert_1',
      pending: false,
      microTime: 1003,
      tx: {
        contractId: 'ct_profile',
        function: 'set_x_name_with_attestation',
        callerId: 'ak_reverted_user',
        returnType: 'revert',
        arguments: [{ value: 'RevertedX' }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      profileXVerificationRewardService.sendRewardIfEligible,
    ).not.toHaveBeenCalled();
  });

  it('does not reward when x verification tx return type is uppercase revert', async () => {
    const { service, websocketService, profileXVerificationRewardService } =
      setup(true);
    service.onModuleInit();
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

    callback({
      hash: 'th_x_revert_upper_1',
      pending: false,
      microTime: 1004,
      tx: {
        contractId: 'ct_profile',
        function: 'set_x_name_with_attestation',
        callerId: 'ak_reverted_user_upper',
        returnType: 'REVERT',
        arguments: [{ value: 'RevertedUpper' }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      profileXVerificationRewardService.sendRewardIfEligible,
    ).not.toHaveBeenCalled();
  });

  it('does not reward when x verification tx has no return type', async () => {
    const { service, websocketService, profileXVerificationRewardService } =
      setup(true);
    service.onModuleInit();
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

    callback({
      hash: 'th_x_no_return_type_1',
      pending: false,
      microTime: 1005,
      tx: {
        contractId: 'ct_profile',
        function: 'set_x_name_with_attestation',
        callerId: 'ak_missing_return_type',
        arguments: [{ value: 'NoReturnType' }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      profileXVerificationRewardService.sendRewardIfEligible,
    ).not.toHaveBeenCalled();
  });

  it('ignores duplicate transaction hashes', async () => {
    const { service, websocketService, profileIndexerService } = setup(true);
    service.onModuleInit();
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];
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
    const {
      service,
      websocketService,
      profileIndexerService,
      profileContractService,
    } = setup(true);
    profileContractService.decodeEvents.mockResolvedValue([
      {
        name: 'CustomNameAutoRenamed',
        args: ['ak_loser', 'old|new'],
      },
    ]);

    service.onModuleInit();
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

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
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

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
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

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

  it('rewards nested PayingForTx using caller, not payer', async () => {
    const {
      service,
      websocketService,
      profileXVerificationRewardService,
      profileIndexerService,
    } = setup(true);
    service.onModuleInit();
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

    callback({
      hash: 'th_payfor_x_success_1',
      pending: false,
      microTime: 790,
      tx: {
        fee: '100',
        payerId: 'ak_team_payer',
        tx: {
          signatures: ['sg_inner'],
          tx: {
            contractId: 'ct_profile',
            function: 'set_x_name_with_attestation',
            callerId: 'ak_verified_user',
            returnType: 'ok',
            arguments: [{ value: '@VerifiedUser' }],
            log: [],
          },
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      profileXVerificationRewardService.sendRewardIfEligible,
    ).toHaveBeenCalledWith('ak_verified_user', 'verifieduser');
    expect(
      profileXVerificationRewardService.sendRewardIfEligible,
    ).not.toHaveBeenCalledWith('ak_team_payer', expect.any(String));
    expect(profileIndexerService.refreshAddress).toHaveBeenCalledWith(
      'ak_verified_user',
      '790',
    );
  });

  it('does not reward nested PayingForTx when inner tx is reverted', async () => {
    const { service, websocketService, profileXVerificationRewardService } =
      setup(true);
    service.onModuleInit();
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

    callback({
      hash: 'th_payfor_x_revert_1',
      pending: false,
      microTime: 791,
      tx: {
        fee: '100',
        payerId: 'ak_team_payer',
        tx: {
          signatures: ['sg_inner'],
          tx: {
            contractId: 'ct_profile',
            function: 'set_x_name_with_attestation',
            callerId: 'ak_verified_user',
            returnType: 'revert',
            arguments: [{ value: 'verifieduser' }],
            log: [],
          },
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      profileXVerificationRewardService.sendRewardIfEligible,
    ).not.toHaveBeenCalled();
  });

  it('rewards inner caller for sponsored x verification payload', async () => {
    const {
      service,
      websocketService,
      profileXVerificationRewardService,
      profileIndexerService,
    } = setup(true);
    service.onModuleInit();
    const callback =
      websocketService.subscribeForTransactionsUpdates.mock.calls[0][0];

    callback({
      hash: 'th_x_payfor_nested_1',
      pending: false,
      microTime: 2001,
      tx: {
        contractId: 'ct_outer_not_profile',
        function: 'paying_for',
        callerId: 'ak_team_payer',
        payerId: 'ak_team_payer',
        tx: {
          signatures: ['sg_inner'],
          tx: {
            contractId: 'ct_profile',
            function: 'set_x_name_with_attestation',
            callerId: 'ak_verified_user',
            returnType: 'ok',
            arguments: [{ value: '@VerifiedOnX' }],
            log: [],
          },
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      profileXVerificationRewardService.sendRewardIfEligible,
    ).toHaveBeenCalledWith('ak_verified_user', 'verifiedonx');
    expect(profileIndexerService.refreshAddress).toHaveBeenCalledWith(
      'ak_verified_user',
      '2001',
    );
    expect(profileIndexerService.refreshAddress).not.toHaveBeenCalledWith(
      'ak_team_payer',
      '2001',
    );
  });
});
