import { fetchJson } from '@/utils/common';
import { ProfileIndexerService } from './profile-indexer.service';

jest.mock('@/utils/common', () => ({
  fetchJson: jest.fn(),
}));

describe('ProfileIndexerService', () => {
  const fetchJsonMock = fetchJson as jest.MockedFunction<typeof fetchJson>;

  const createService = () => {
    const profileCacheRepository = {
      upsert: jest.fn().mockResolvedValue(undefined),
    } as any;
    const profileSyncStateRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'global',
        last_indexed_micro_time: '0',
      }),
      update: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
    } as any;
    const profileContractService = {
      isConfigured: jest.fn().mockReturnValue(true),
      getContractAddress: jest
        .fn()
        .mockReturnValue('ct_J54WNvrpzK95kPFDE83qcggoxwABzPdBT8YkUyaLqTfNvcfHk'),
      getProfile: jest.fn().mockResolvedValue({
        fullname: '',
        bio: '',
        avatarurl: '',
        username: null,
        x_username: null,
        chain_name: null,
        display_source: 'custom',
        chain_expires_at: null,
      }),
      decodeEvents: jest.fn().mockResolvedValue([]),
    } as any;
    const profileXVerificationRewardService = {
      sendRewardIfEligible: jest.fn().mockResolvedValue(undefined),
    } as any;

    const service = new ProfileIndexerService(
      profileCacheRepository,
      profileSyncStateRepository,
      profileContractService,
      profileXVerificationRewardService,
    );

    return {
      service,
      profileXVerificationRewardService,
      profileSyncStateRepository,
      profileContractService,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rewards once for pending->confirmed hash transition in backfill stream', async () => {
    const {
      service,
      profileXVerificationRewardService,
      profileSyncStateRepository,
    } = createService();
    (service as any).maxRecentRewardTxHashes = 2;

    fetchJsonMock.mockResolvedValueOnce({
      data: [
        {
          hash: 'th_pending_then_confirmed',
          micro_time: '200',
          pending: true,
          tx: {
            contract_id: 'ct_J54WNvrpzK95kPFDE83qcggoxwABzPdBT8YkUyaLqTfNvcfHk',
            function: 'set_x_name_with_attestation',
            caller_id: 'ak_verified',
            return_type: 'ok',
            arguments: [{ value: '@Verified' }],
          },
        },
        {
          hash: 'th_pending_then_confirmed',
          micro_time: '201',
          pending: false,
          tx: {
            contract_id: 'ct_J54WNvrpzK95kPFDE83qcggoxwABzPdBT8YkUyaLqTfNvcfHk',
            function: 'set_x_name_with_attestation',
            caller_id: 'ak_verified',
            return_type: 'ok',
            arguments: [{ value: '@Verified' }],
          },
        },
        {
          hash: 'th_other',
          micro_time: '202',
          pending: false,
          tx: {
            contract_id: 'ct_J54WNvrpzK95kPFDE83qcggoxwABzPdBT8YkUyaLqTfNvcfHk',
            function: 'set_profile',
            caller_id: 'ak_other',
          },
        },
        {
          hash: 'th_pending_then_confirmed',
          micro_time: '203',
          pending: false,
          tx: {
            contract_id: 'ct_J54WNvrpzK95kPFDE83qcggoxwABzPdBT8YkUyaLqTfNvcfHk',
            function: 'set_x_name_with_attestation',
            caller_id: 'ak_verified',
            return_type: 'ok',
            arguments: [{ value: '@Verified' }],
          },
        },
      ],
      next: null,
    } as any);

    await service.syncProfileChanges();
    await new Promise((resolve) => setImmediate(resolve));

    expect(profileXVerificationRewardService.sendRewardIfEligible).toHaveBeenCalledTimes(
      1,
    );
    expect(profileXVerificationRewardService.sendRewardIfEligible).toHaveBeenCalledWith(
      'ak_verified',
      'verified',
    );
    expect(profileSyncStateRepository.update).toHaveBeenCalled();
  });

  it('does not advance sync state before reward dispatch settles', async () => {
    const {
      service,
      profileXVerificationRewardService,
      profileSyncStateRepository,
    } = createService();

    let resolveReward: (() => void) | null = null;
    profileXVerificationRewardService.sendRewardIfEligible.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveReward = resolve;
        }),
    );

    fetchJsonMock.mockResolvedValueOnce({
      data: [
        {
          hash: 'th_reward_wait',
          micro_time: '200',
          pending: false,
          tx: {
            contract_id: 'ct_J54WNvrpzK95kPFDE83qcggoxwABzPdBT8YkUyaLqTfNvcfHk',
            function: 'set_x_name_with_attestation',
            caller_id: 'ak_verified',
            return_type: 'ok',
            arguments: [{ value: '@Verified' }],
          },
        },
      ],
      next: null,
    } as any);

    const syncPromise = service.syncProfileChanges();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(profileSyncStateRepository.update).not.toHaveBeenCalled();
    expect(resolveReward).not.toBeNull();

    resolveReward?.();
    await syncPromise;

    expect(profileSyncStateRepository.update).toHaveBeenCalledTimes(1);
  });

  it('advances sync state even when reward dispatch rejects', async () => {
    const {
      service,
      profileXVerificationRewardService,
      profileSyncStateRepository,
    } = createService();

    profileXVerificationRewardService.sendRewardIfEligible.mockRejectedValue(
      new Error('spend failed'),
    );

    fetchJsonMock.mockResolvedValueOnce({
      data: [
        {
          hash: 'th_reward_fail',
          micro_time: '200',
          pending: false,
          tx: {
            contract_id: 'ct_J54WNvrpzK95kPFDE83qcggoxwABzPdBT8YkUyaLqTfNvcfHk',
            function: 'set_x_name_with_attestation',
            caller_id: 'ak_verified',
            return_type: 'ok',
            arguments: [{ value: '@Verified' }],
          },
        },
      ],
      next: null,
    } as any);

    await service.syncProfileChanges();

    expect(profileSyncStateRepository.update).toHaveBeenCalledTimes(1);
  });

  it('does not set public_name from chain/x when display source is custom', async () => {
    const { service, profileContractService } = createService();
    profileContractService.getProfile.mockResolvedValue({
      fullname: '',
      bio: '',
      avatarurl: '',
      username: null,
      x_username: 'x_name',
      chain_name: 'chain_name',
      display_source: 'custom',
      chain_expires_at: null,
    });

    const upsertMock = (service as any).profileCacheRepository.upsert as jest.Mock;
    await service.refreshAddress('ak_custom_source');

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][0]).toMatchObject({
      display_source: 'custom',
      public_name: null,
      chain_name: 'chain_name',
      x_username: 'x_name',
    });
  });

  it('does not set public_name from custom/x when display source is chain', async () => {
    const { service, profileContractService } = createService();
    profileContractService.getProfile.mockResolvedValue({
      fullname: '',
      bio: '',
      avatarurl: '',
      username: 'custom_name',
      x_username: 'x_name',
      chain_name: null,
      display_source: 'chain',
      chain_expires_at: null,
    });

    const upsertMock = (service as any).profileCacheRepository.upsert as jest.Mock;
    await service.refreshAddress('ak_chain_source');

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][0]).toMatchObject({
      display_source: 'chain',
      public_name: null,
      username: 'custom_name',
      x_username: 'x_name',
    });
  });

  it('skips reward dispatch for successful tx without hash', async () => {
    const {
      service,
      profileXVerificationRewardService,
      profileSyncStateRepository,
    } = createService();

    fetchJsonMock.mockResolvedValueOnce({
      data: [
        {
          micro_time: '200',
          pending: false,
          tx: {
            contract_id: 'ct_J54WNvrpzK95kPFDE83qcggoxwABzPdBT8YkUyaLqTfNvcfHk',
            function: 'set_x_name_with_attestation',
            caller_id: 'ak_verified',
            return_type: 'ok',
            arguments: [{ value: '@Verified' }],
          },
        },
        {
          micro_time: '201',
          pending: false,
          tx: {
            contract_id: 'ct_J54WNvrpzK95kPFDE83qcggoxwABzPdBT8YkUyaLqTfNvcfHk',
            function: 'set_x_name_with_attestation',
            caller_id: 'ak_verified',
            return_type: 'ok',
            arguments: [{ value: '@Verified' }],
          },
        },
      ],
      next: null,
    } as any);

    await service.syncProfileChanges();

    expect(profileXVerificationRewardService.sendRewardIfEligible).not.toHaveBeenCalled();
    expect(profileSyncStateRepository.update).toHaveBeenCalled();
  });
});
