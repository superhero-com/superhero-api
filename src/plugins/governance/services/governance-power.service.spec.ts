import {
  GovernancePowerService,
  resolveActiveDelegations,
  resolveDelegationTarget,
  resolveLatestVotes,
} from './governance-power.service';

const vote = (
  voter: string,
  option: number,
  block_height: number,
  created_at = new Date(block_height * 1000),
) => ({
  function: 'vote',
  block_height,
  created_at,
  data: { voter, option },
});
const revokeVote = (voter: string, block_height: number) => ({
  function: 'revoke_vote',
  block_height,
  created_at: new Date(block_height * 1000),
  data: { voter },
});
const delegate = (
  delegator: string,
  delegatee: string,
  block_height: number,
  micro_time = String(block_height),
) => ({ delegator, delegatee, block_height, micro_time });
const revoke = (delegator: string, block_height: number) => ({
  delegator,
  block_height,
  micro_time: String(block_height),
});

describe('governance power helpers', () => {
  it('keeps each voter latest vote and drops revoked ones', () => {
    const latest = resolveLatestVotes(
      [
        vote('ak_a', 0, 10),
        vote('ak_a', 1, 12),
        vote('ak_b', 0, 11),
        revokeVote('ak_b', 13),
        vote('ak_c', 1, 50),
      ] as any,
      20,
    );
    expect([...latest.entries()]).toEqual([['ak_a', 1]]);
  });

  it('applies delegations and revocations up to the height only', () => {
    const active = resolveActiveDelegations(
      [delegate('ak_d', 'ak_a', 5), delegate('ak_e', 'ak_a', 6)] as any,
      [revoke('ak_e', 8), revoke('ak_d', 30)] as any,
      20,
    );
    expect(Object.fromEntries(active)).toEqual({ ak_d: 'ak_a' });
  });

  it('re-delegation replaces the earlier delegatee', () => {
    const active = resolveActiveDelegations(
      [delegate('ak_d', 'ak_a', 5), delegate('ak_d', 'ak_b', 7)] as any,
      [],
      20,
    );
    expect(active.get('ak_d')).toBe('ak_b');
  });

  it('follows chains to the first voter and ignores cycles', () => {
    const active = new Map([
      ['ak_x', 'ak_y'],
      ['ak_y', 'ak_a'],
      ['ak_p', 'ak_q'],
      ['ak_q', 'ak_p'],
    ]);
    const voters = new Set(['ak_a']);
    expect(resolveDelegationTarget('ak_x', active, voters)).toBe('ak_a');
    expect(resolveDelegationTarget('ak_p', active, voters)).toBeNull();
    expect(resolveDelegationTarget('ak_z', active, voters)).toBeNull();
  });
});

describe('GovernancePowerService', () => {
  const pollAddress = 'ct_poll';
  const balances: Record<string, string> = {
    ak_a: '100',
    ak_b: '50',
    ak_d: '25',
    ak_e: '5',
  };

  const build = (closeAt: number, height = 1000) => {
    const pollRepository = {
      findOne: jest.fn().mockResolvedValue({
        poll_address: pollAddress,
        close_at_height: closeAt,
        vote_options: [
          { key: 0, val: 'Yes' },
          { key: 1, val: 'No' },
        ],
      }),
    };
    const voteRepository = {
      find: jest
        .fn()
        .mockResolvedValue([vote('ak_a', 0, 10), vote('ak_b', 1, 11)]),
    };
    const delegationRepository = {
      find: jest
        .fn()
        .mockResolvedValue([
          delegate('ak_d', 'ak_a', 5),
          delegate('ak_e', 'ak_b', 6),
          delegate('ak_b', 'ak_a', 7),
        ]),
    };
    const revokedDelegationRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    const getBalance = jest.fn(
      async (account: string) => balances[account] ?? '0',
    );
    const aeSdkService = {
      sdk: { getHeight: jest.fn().mockResolvedValue(height), getBalance },
    };
    const service = new GovernancePowerService(
      pollRepository as any,
      voteRepository as any,
      delegationRepository as any,
      revokedDelegationRepository as any,
      aeSdkService as any,
    );
    return { service, getBalance, pollRepository };
  };

  it('weights options by own plus delegated stake', async () => {
    const { service } = build(2000);
    const result = await service.getPollPower(pollAddress);

    expect(result.closed).toBe(false);
    expect(result.height).toBe(1000);
    expect(result.total_stake).toBe('180');
    expect(result.votes_count).toBe(2);
    // ak_b voted itself, so its delegation to ak_a does not move its power.
    expect(result.options).toEqual([
      { option: 0, label: 'Yes', stake: '125', percentage: '69.44', votes: 1 },
      { option: 1, label: 'No', stake: '55', percentage: '30.56', votes: 1 },
    ]);
    expect(result.voters[0]).toMatchObject({
      account: 'ak_a',
      balance: '100',
      delegated: '25',
      stake: '125',
      delegators: ['ak_d'],
    });
  });

  it('uses the close height for closed polls and caches the result', async () => {
    const { service, getBalance, pollRepository } = build(900);
    const first = await service.getPollPower(pollAddress);
    expect(first.closed).toBe(true);
    expect(first.height).toBe(900);
    expect(getBalance).toHaveBeenCalledWith(
      'ak_a',
      expect.objectContaining({ height: 900 }),
    );

    await service.getPollPower(pollAddress);
    expect(pollRepository.findOne).toHaveBeenCalledTimes(1);
  });

  it('reports an account delegated power, skipping delegators who voted', async () => {
    const { service } = build(2000);

    const general = await service.getDelegatedPower('ak_a');
    expect(general.delegators.sort()).toEqual(['ak_b', 'ak_d', 'ak_e']);
    expect(general.delegated_power).toBe('80');
    expect(general.total_power).toBe('180');

    const inPoll = await service.getDelegatedPower('ak_a', pollAddress);
    expect(inPoll.delegators).toEqual(['ak_d']);
    expect(inPoll.total_power).toBe('125');
  });
});
