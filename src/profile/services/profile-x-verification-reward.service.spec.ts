jest.mock('../profile.constants', () => ({
  PROFILE_X_VERIFICATION_MIN_FOLLOWERS: 50,
  PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE: '0.01',
  PROFILE_X_VERIFICATION_REWARD_FETCH_TIMEOUT_MS: 5000,
  PROFILE_X_VERIFICATION_REWARD_RETRY_BASE_SECONDS: 1,
  PROFILE_X_VERIFICATION_REWARD_RETRY_MAX_SECONDS: 60,
  PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY:
    '1111111111111111111111111111111111111111111111111111111111111111',
}));

import { ProfileXVerificationRewardService } from './profile-x-verification-reward.service';
import { ProfileXVerificationReward } from '../entities/profile-x-verification-reward.entity';
import { ProfileXApiClientService } from './profile-x-api-client.service';

describe('ProfileXVerificationRewardService', () => {
  const originalFetch = global.fetch;
  let xFollowersCount = 75;

  type RewardRow = Partial<ProfileXVerificationReward> & { address: string };

  beforeEach(() => {
    xFollowersCount = 75;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'x_app_token', expires_in: 3600 }),
        } as any;
      }
      if (url.includes('/2/users/by/username/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { public_metrics: { followers_count: xFollowersCount } },
          }),
        } as any;
      }
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    }) as any;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  const extractFindOperatorValue = (value: any) =>
    value?._value ?? value?.value;

  const createRowsStore = (seed?: RewardRow[]) => {
    const rows = new Map<string, RewardRow>();
    for (const row of seed || []) {
      rows.set(row.address, {
        retry_count: 0,
        status: 'pending',
        ...row,
      });
    }
    return rows;
  };

  const getService = (overrides?: {
    rows?: Map<string, RewardRow>;
    aeSdkService?: any;
    profileXInviteService?: any;
    profileSpendQueueService?: any;
    dataSource?: any;
  }) => {
    const rows = overrides?.rows || createRowsStore();

    const rewardRepository = {
      findOne: jest.fn().mockImplementation(async ({ where }) => {
        if (where?.address) {
          return rows.get(where.address) || null;
        }
        return null;
      }),
      find: jest.fn().mockImplementation(async () => {
        const now = Date.now();
        return Array.from(rows.values()).filter((row) => {
          if (row.status === 'pending' && !row.next_retry_at) {
            return true;
          }
          if (
            (row.status === 'pending' || row.status === 'failed') &&
            row.next_retry_at
          ) {
            return new Date(row.next_retry_at).getTime() <= now;
          }
          return false;
        });
      }),
      create: jest.fn().mockImplementation((value) => ({
        retry_count: 0,
        status: 'pending',
        ...value,
      })),
      save: jest.fn().mockImplementation(async (value) => {
        rows.set(value.address, {
          ...rows.get(value.address),
          ...value,
        });
        return rows.get(value.address);
      }),
    } as any;

    const managerRepo = {
      createQueryBuilder: jest.fn().mockImplementation(() => {
        const state: { address?: string } = {};
        return {
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockImplementation((_query: string, params: any) => {
            state.address = params.address;
            return {
              getOne: jest
                .fn()
                .mockResolvedValue(
                  state.address ? rows.get(state.address) || null : null,
                ),
            };
          }),
        };
      }),
      findOne: jest.fn().mockImplementation(async ({ where }) => {
        const xUsername = where?.x_username;
        const excludedAddress = extractFindOperatorValue(where?.address);
        for (const row of rows.values()) {
          if (row.address === excludedAddress) {
            continue;
          }
          if (row.x_username !== xUsername) {
            continue;
          }
          if (row.status === 'pending' || row.status === 'paid') {
            return row;
          }
        }
        return null;
      }),
      save: jest.fn().mockImplementation(async (value) => {
        rows.set(value.address, {
          ...rows.get(value.address),
          ...value,
        });
        return rows.get(value.address);
      }),
    } as any;

    const dataSource =
      overrides?.dataSource ||
      ({
        transaction: jest
          .fn()
          .mockImplementation(async (work: (manager: any) => Promise<any>) =>
            work({
              getRepository: jest.fn().mockReturnValue(managerRepo),
            }),
          ),
      } as any);

    const aeSdkService =
      overrides?.aeSdkService ||
      ({
        sdk: {
          spend: jest.fn().mockResolvedValue({ hash: 'th_reward_1' }),
        },
      } as any);
    const profileXInviteService =
      overrides?.profileXInviteService ||
      ({
        processInviteeXVerified: jest.fn().mockResolvedValue(undefined),
      } as any);
    const profileSpendQueueService =
      overrides?.profileSpendQueueService ||
      ({
        enqueueSpend: jest.fn().mockImplementation(async (_k, work) => work()),
        getRewardAccount: jest.fn().mockReturnValue({}),
      } as any);
    const profileXApiClientService = new ProfileXApiClientService();

    const service = new ProfileXVerificationRewardService(
      rewardRepository,
      dataSource,
      aeSdkService,
      profileXInviteService,
      profileSpendQueueService,
      profileXApiClientService,
    );
    return {
      service,
      rewardRepository,
      aeSdkService,
      profileXInviteService,
      profileSpendQueueService,
      rows,
      managerRepo,
      dataSource,
    };
  };

  it('pays when followers count is exactly 50', async () => {
    xFollowersCount = 50;
    const { service, aeSdkService, rows } = getService();

    await service.sendRewardIfEligible(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      'reward_user',
    );

    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(1);
    expect(aeSdkService.sdk.spend).toHaveBeenCalledWith(
      '10000000000000000',
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      { onAccount: {} },
    );
    expect(
      rows.get('ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo')?.status,
    ).toBe('paid');
  });

  it('marks below-threshold users as terminal ineligible', async () => {
    xFollowersCount = 49;
    const { service, aeSdkService, rows } = getService();

    await service.sendRewardIfEligible(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      'too_small',
    );

    const row = rows.get(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
    );
    expect(aeSdkService.sdk.spend).not.toHaveBeenCalled();
    expect(row?.status).toBe('ineligible_followers');
    expect(row?.next_retry_at).toBeNull();
  });

  it('schedules retry when spend fails and later pays on retry', async () => {
    const aeSdkService = {
      sdk: {
        spend: jest
          .fn()
          .mockRejectedValueOnce(new Error('insufficient balance'))
          .mockResolvedValueOnce({ hash: 'th_reward_2' }),
      },
    } as any;
    const { service, rows } = getService({ aeSdkService });

    const address = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';
    await service.sendRewardIfEligible(address, 'retry_user');
    let row = rows.get(address);
    expect(row?.status).toBe('pending');
    expect(row?.retry_count).toBe(1);
    expect(row?.next_retry_at).toBeTruthy();

    rows.set(address, {
      ...row!,
      next_retry_at: new Date(Date.now() - 1000),
    });

    await service.processDueRewards();
    row = rows.get(address);
    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(2);
    expect(row?.status).toBe('paid');
    expect(row?.tx_hash).toBe('th_reward_2');
    expect(row?.next_retry_at).toBeNull();
  });

  it('avoids duplicate payout for concurrent same-address requests', async () => {
    let resolveSpend: (() => void) | null = null;
    const aeSdkService = {
      sdk: {
        spend: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveSpend = () => resolve({ hash: 'th_reward_once' });
            }),
        ),
      },
    } as any;
    const { service, rows } = getService({ aeSdkService });
    const address = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';
    const first = service.sendRewardIfEligible(address, 'same_user');
    const second = service.sendRewardIfEligible(address, 'same_user');

    await new Promise((resolve) => setImmediate(resolve));
    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(1);
    resolveSpend?.();
    await Promise.all([first, second]);

    expect(rows.get(address)?.status).toBe('paid');
    expect(rows.get(address)?.tx_hash).toBe('th_reward_once');
  });

  it('marks as blocked when username is already rewarded elsewhere', async () => {
    const rows = createRowsStore([
      {
        address: 'ak_paid_owner',
        x_username: 'alice',
        status: 'paid',
      },
    ]);
    const { service, aeSdkService } = getService({ rows });

    await service.sendRewardIfEligible(
      'ak_2qUqjP8J5Mdrrnw9MhQN9jQHX8RWqA27RSh4BnhJrg5ioLHFgC',
      'alice',
    );

    const row = rows.get(
      'ak_2qUqjP8J5Mdrrnw9MhQN9jQHX8RWqA27RSh4BnhJrg5ioLHFgC',
    );
    expect(aeSdkService.sdk.spend).not.toHaveBeenCalled();
    expect(row?.status).toBe('blocked_username_conflict');
    expect(row?.next_retry_at).toBeNull();
  });

  it('retries when X lookup fails instead of losing reward', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'x_app_token', expires_in: 3600 }),
        } as any;
      }
      throw new Error('x api down');
    });

    const { service, aeSdkService, rows } = getService();
    const address = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';
    await service.sendRewardIfEligible(address, 'lookup_failure_user');
    const row = rows.get(address);
    expect(aeSdkService.sdk.spend).not.toHaveBeenCalled();
    expect(row?.status).toBe('pending');
    expect(row?.retry_count).toBe(1);
    expect(row?.next_retry_at).toBeTruthy();
  });

  it('marks terminal X lookup failures without scheduling endless retries', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'x_app_token', expires_in: 3600 }),
        } as any;
      }
      if (url.includes('/2/users/by/username/')) {
        return {
          ok: false,
          status: 404,
          json: async () => ({
            errors: [
              { message: 'Could not find user with username: missing_user' },
            ],
          }),
        } as any;
      }
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    });

    const { service, aeSdkService, rows } = getService();
    const address = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';

    await service.sendRewardIfEligible(address, 'missing_user');

    const row = rows.get(address);
    expect(aeSdkService.sdk.spend).not.toHaveBeenCalled();
    expect(row?.status).toBe('failed');
    expect(row?.next_retry_at).toBeNull();

    await service.processDueRewards();
    expect(aeSdkService.sdk.spend).not.toHaveBeenCalled();
  });

  it('keeps spend execution outside the database transaction', async () => {
    let inTransaction = false;
    const rows = createRowsStore();
    const managerRepo = {
      createQueryBuilder: jest.fn().mockImplementation(() => {
        const state: { address?: string } = {};
        return {
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockImplementation((_query: string, params: any) => {
            state.address = params.address;
            return {
              getOne: jest
                .fn()
                .mockResolvedValue(
                  state.address ? rows.get(state.address) || null : null,
                ),
            };
          }),
        };
      }),
      findOne: jest.fn().mockImplementation(async ({ where }) => {
        const xUsername = where?.x_username;
        const excludedAddress = extractFindOperatorValue(where?.address);
        for (const row of rows.values()) {
          if (row.address === excludedAddress) {
            continue;
          }
          if (row.x_username !== xUsername) {
            continue;
          }
          if (row.status === 'pending' || row.status === 'paid') {
            return row;
          }
        }
        return null;
      }),
      save: jest.fn().mockImplementation(async (value) => {
        rows.set(value.address, {
          ...rows.get(value.address),
          ...value,
        });
        return rows.get(value.address);
      }),
    } as any;
    const dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(async (work: (manager: any) => Promise<any>) => {
          inTransaction = true;
          try {
            return await work({
              getRepository: jest.fn().mockReturnValue(managerRepo),
            });
          } finally {
            inTransaction = false;
          }
        }),
    } as any;
    const aeSdkService = {
      sdk: {
        spend: jest.fn().mockImplementation(async () => {
          expect(inTransaction).toBe(false);
          return { hash: 'th_reward_outside_tx' };
        }),
      },
    } as any;

    const { service } = getService({ rows, aeSdkService, dataSource });

    await service.sendRewardIfEligible(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      'outside_tx_user',
    );

    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(1);
  });

  it('triggers invite verification credit after successful payout', async () => {
    const { service, profileXInviteService } = getService();

    await service.sendRewardIfEligible(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      'reward_user_hook',
    );

    expect(profileXInviteService.processInviteeXVerified).toHaveBeenCalledWith(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
    );
  });
});
