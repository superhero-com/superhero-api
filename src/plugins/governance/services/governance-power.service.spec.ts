import { NotFoundException } from '@nestjs/common';
import { LessThanOrEqual } from 'typeorm';
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
const revokeVote = (
  voter: string,
  block_height: number,
  created_at = new Date(block_height * 1000),
) => ({
  function: 'revoke_vote',
  block_height,
  created_at,
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

  it('orders a vote, revoke and re-vote within one height by time', () => {
    // Production poll ct_DpHE… has exactly this sequence at height 1197606.
    const at = (seconds: string) => new Date(`2025-10-25T09:11:${seconds}Z`);
    const events = [
      vote('ak_v', 2, 1197606, at('58.127')),
      revokeVote('ak_v', 1197606, at('48.108')),
      vote('ak_v', 2, 1197606, at('38.086')),
    ];
    expect(
      Object.fromEntries(resolveLatestVotes(events as any, 1197696)),
    ).toEqual({ ak_v: 2 });
    expect(resolveLatestVotes(events.slice(1) as any, 1197696).size).toBe(0);
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
    ak_x: '7',
  };

  // Shaped like a real row: the middleware decodes the `option(int)` close
  // height as `[1, h]` for `Some(h)` and `[0]` for `None`.
  const pollRow = (closeHeight: number | null) => ({
    poll_address: pollAddress,
    close_at_height: closeHeight == null ? 0 : 1,
    close_height: closeHeight,
    vote_options: [
      { key: 0, val: 'Yes' },
      { key: 1, val: 'No' },
    ],
  });

  const build = ({
    closeHeight = 2000,
    height = 1000,
    pollExists = true,
    votes = [vote('ak_a', 0, 10), vote('ak_b', 1, 11)],
    delegations = [
      delegate('ak_d', 'ak_a', 5),
      delegate('ak_e', 'ak_b', 6),
      delegate('ak_b', 'ak_a', 7),
    ],
  }: {
    closeHeight?: number | null;
    height?: number;
    pollExists?: boolean;
    votes?: unknown[];
    delegations?: unknown[];
  } = {}) => {
    const pollRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue(pollExists ? pollRow(closeHeight) : null),
    };
    const voteRepository = { find: jest.fn().mockResolvedValue(votes) };
    const delegationRepository = {
      find: jest.fn().mockResolvedValue(delegations),
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
    return { service, getBalance, delegationRepository };
  };

  it('weights an open poll by own plus delegated stake at the latest state', async () => {
    const { service, getBalance } = build();
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
    expect(getBalance).toHaveBeenCalledWith(
      'ak_a',
      expect.objectContaining({ height: undefined }),
    );
  });

  it('counts a closed poll at its close height', async () => {
    const { service, getBalance, delegationRepository } = build({
      closeHeight: 900,
    });
    const result = await service.getPollPower(pollAddress);

    expect(result.closed).toBe(true);
    expect(result.height).toBe(900);
    expect(result.total_stake).toBe('180');
    expect(getBalance).toHaveBeenCalledWith(
      'ak_a',
      expect.objectContaining({ height: 900 }),
    );
    expect(delegationRepository.find).toHaveBeenCalledWith({
      where: { block_height: LessThanOrEqual(900) },
    });
  });

  it('keeps a poll without a close height open', async () => {
    const { service } = build({ closeHeight: null });
    const result = await service.getPollPower(pollAddress);

    expect(result.closed).toBe(false);
    expect(result.height).toBe(1000);
    expect(result.votes_count).toBe(2);
  });

  it('reports zero stake for a poll without votes', async () => {
    const { service, getBalance } = build({ votes: [] });
    const result = await service.getPollPower(pollAddress);

    expect(result).toMatchObject({
      total_stake: '0',
      votes_count: 0,
      voters: [],
      options: [
        { option: 0, label: 'Yes', stake: '0', percentage: '0.00', votes: 0 },
        { option: 1, label: 'No', stake: '0', percentage: '0.00', votes: 0 },
      ],
    });
    expect(getBalance).not.toHaveBeenCalled();
  });

  it('propagates a failed balance lookup instead of counting zero', async () => {
    const { service, getBalance } = build();
    getBalance.mockRejectedValue(new Error('node unavailable'));

    await expect(service.getPollPower(pollAddress)).rejects.toThrow(
      'node unavailable',
    );
    await expect(service.getDelegatedPower('ak_a')).rejects.toThrow(
      'node unavailable',
    );
  });

  it('returns 404 for an unknown poll', async () => {
    const { service } = build({ pollExists: false });

    await expect(service.getPollPower(pollAddress)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.getDelegatedPower('ak_a', pollAddress),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports an account delegated power, skipping delegators who voted', async () => {
    const { service } = build();

    const general = await service.getDelegatedPower('ak_a');
    expect(general.delegators.sort()).toEqual(['ak_b', 'ak_d', 'ak_e']);
    expect(general.delegated_power).toBe('80');
    expect(general.total_power).toBe('180');

    const inPoll = await service.getDelegatedPower('ak_a', pollAddress);
    expect(inPoll.delegators).toEqual(['ak_d']);
    expect(inPoll.total_power).toBe('125');
  });

  it('does not list an account as its own delegator through a cycle', async () => {
    const { service } = build({
      delegations: [delegate('ak_a', 'ak_x', 5), delegate('ak_x', 'ak_a', 6)],
    });

    const result = await service.getDelegatedPower('ak_a');
    expect(result).toMatchObject({
      delegatee: 'ak_x',
      delegators: ['ak_x'],
      total_power: '107',
    });
  });
});
