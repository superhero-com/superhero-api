import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { AE_AMOUNT_FORMATS, Encoded } from '@aeternity/aepp-sdk';
import BigNumber from 'bignumber.js';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { GovernancePoll } from '../entities/governance-poll.view';
import { GovernancePollVote } from '../entities/governance-poll-vote.view';
import { GovernanceDelegation } from '../entities/governance-delegation.view';
import { GovernanceRevokedDelegation } from '../entities/governance-revoked-delegation.view';

/** Ordering key of an on-chain event: block height, then micro time. */
interface ChainPosition {
  block_height: number;
  micro_time?: string | number | null;
  created_at?: Date | string | null;
}

export interface DelegationEdge {
  delegator: string;
  delegatee: string;
}

export interface VoterStake {
  account: string;
  option: number;
  /** Own AE balance at the poll height. */
  balance: string;
  /** AE delegated to this voter (directly or through a chain). */
  delegated: string;
  /** balance + delegated. */
  stake: string;
  /** Accounts whose power flows into this voter. */
  delegators: string[];
}

export interface OptionStake {
  option: number;
  label?: string;
  stake: string;
  percentage: string;
  votes: number;
}

export interface PollPowerResult {
  poll_address: string;
  height: number;
  closed: boolean;
  total_stake: string;
  votes_count: number;
  options: OptionStake[];
  voters: VoterStake[];
}

export interface DelegatedPowerResult {
  account: string;
  height: number;
  delegatee: string | null;
  balance: string;
  delegated_power: string;
  total_power: string;
  delegators: string[];
}

const BALANCE_CONCURRENCY = 8;

function comparePosition(a: ChainPosition, b: ChainPosition): number {
  if (a.block_height !== b.block_height) {
    return a.block_height - b.block_height;
  }
  const am = a.micro_time != null ? Number(a.micro_time) : NaN;
  const bm = b.micro_time != null ? Number(b.micro_time) : NaN;
  if (!Number.isNaN(am) && !Number.isNaN(bm) && am !== bm) {
    return am - bm;
  }
  const at = a.created_at ? new Date(a.created_at).getTime() : 0;
  const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
  return at - bt;
}

/**
 * Active delegations at `height`: each delegator's latest delegate /
 * revoke_delegation event at or before the height decides its state.
 */
export function resolveActiveDelegations(
  delegations: Array<ChainPosition & { delegator: string; delegatee: string }>,
  revocations: Array<ChainPosition & { delegator: string }>,
  height: number,
): Map<string, string> {
  type Event = ChainPosition & { delegator: string; delegatee: string | null };
  const events: Event[] = [
    ...delegations.map((d) => ({ ...d, delegatee: d.delegatee })),
    ...revocations.map((r) => ({ ...r, delegatee: null })),
  ]
    .filter((e) => e.delegator && e.block_height <= height)
    .sort(comparePosition);

  const active = new Map<string, string>();
  for (const event of events) {
    if (event.delegatee && event.delegatee !== event.delegator) {
      active.set(event.delegator, event.delegatee);
    } else {
      active.delete(event.delegator);
    }
  }
  return active;
}

/**
 * Follow a delegator's chain until it reaches an account that voted.
 * Accounts that voted themselves keep their own power. Cycles and chains
 * that never reach a voter contribute nothing.
 */
export function resolveDelegationTarget(
  account: string,
  active: Map<string, string>,
  voters: Set<string>,
): string | null {
  const seen = new Set<string>([account]);
  let current = active.get(account);
  while (current) {
    if (voters.has(current)) {
      return current;
    }
    if (seen.has(current)) {
      return null;
    }
    seen.add(current);
    current = active.get(current);
  }
  return null;
}

/** Latest non-revoked vote per voter at or before `height`. */
export function resolveLatestVotes(
  votes: Array<
    ChainPosition & {
      function: string;
      data?: { voter?: string; option?: number | string } | null;
    }
  >,
  height: number,
): Map<string, number> {
  const sorted = votes
    .filter((v) => v.block_height <= height && v.data?.voter)
    .sort(comparePosition);
  const latest = new Map<string, number>();
  for (const v of sorted) {
    const voter = v.data!.voter!;
    if (v.function === 'vote' && v.data?.option != null) {
      latest.set(voter, Number(v.data.option));
    } else if (v.function === 'revoke_vote') {
      latest.delete(voter);
    }
  }
  return latest;
}

/**
 * The height a poll is counted at: its close height once the chain reaches
 * it (the contract rejects votes from then on), the current height before.
 * `close_at_height` is not a height: the middleware decodes `Some(h)` as
 * `[1, h]`, so it holds the option tag and `close_height` holds `h`.
 */
function pollHeight(
  poll: GovernancePoll,
  currentHeight: number,
): { closed: boolean; height: number } {
  const closeHeight = poll.close_height ?? null;
  const closed = closeHeight != null && closeHeight <= currentHeight;
  return { closed, height: closed ? closeHeight : currentHeight };
}

/**
 * Stake-weighted governance numbers (#306): per-option stake, total vote
 * power and delegated power, computed from indexed votes/delegations plus
 * on-chain AE balances (at the close height for closed polls, the latest
 * state for open ones).
 */
@Injectable()
export class GovernancePowerService {
  constructor(
    @InjectRepository(GovernancePoll)
    private readonly pollRepository: Repository<GovernancePoll>,
    @InjectRepository(GovernancePollVote)
    private readonly voteRepository: Repository<GovernancePollVote>,
    @InjectRepository(GovernanceDelegation)
    private readonly delegationRepository: Repository<GovernanceDelegation>,
    @InjectRepository(GovernanceRevokedDelegation)
    private readonly revokedDelegationRepository: Repository<GovernanceRevokedDelegation>,
    private readonly aeSdkService: AeSdkService,
  ) {}

  async getPollPower(pollAddress: string): Promise<PollPowerResult> {
    const poll = await this.pollRepository.findOne({
      where: { poll_address: pollAddress },
    });
    if (!poll) {
      throw new NotFoundException(`Poll with address ${pollAddress} not found`);
    }

    const { closed, height } = pollHeight(
      poll,
      await this.aeSdkService.sdk.getHeight(),
    );

    const [votes, active] = await Promise.all([
      this.voteRepository.find({ where: { poll_address: pollAddress } }),
      this.loadActiveDelegations(height),
    ]);

    const latestVotes = resolveLatestVotes(votes as any, height);
    const voters = new Set(latestVotes.keys());

    const delegatorsByVoter = new Map<string, string[]>();
    for (const delegator of active.keys()) {
      if (voters.has(delegator)) continue;
      const target = resolveDelegationTarget(delegator, active, voters);
      if (!target) continue;
      const list = delegatorsByVoter.get(target) ?? [];
      list.push(delegator);
      delegatorsByVoter.set(target, list);
    }

    const accounts = [...voters, ...[...delegatorsByVoter.values()].flat()];
    const balances = await this.getBalances(
      accounts,
      closed ? height : undefined,
    );

    const voterStakes: VoterStake[] = [...latestVotes.entries()].map(
      ([account, option]) => {
        const delegators = delegatorsByVoter.get(account) ?? [];
        const balance = balances.get(account) ?? new BigNumber(0);
        const delegated = delegators.reduce(
          (sum, d) => sum.plus(balances.get(d) ?? 0),
          new BigNumber(0),
        );
        return {
          account,
          option,
          balance: balance.toFixed(),
          delegated: delegated.toFixed(),
          stake: balance.plus(delegated).toFixed(),
          delegators,
        };
      },
    );

    const totalStake = voterStakes.reduce(
      (sum, v) => sum.plus(v.stake),
      new BigNumber(0),
    );

    const labels = new Map<number, string>();
    for (const opt of poll.vote_options ?? []) {
      labels.set(Number(opt.key), opt.val);
    }
    const optionKeys = new Set<number>([
      ...labels.keys(),
      ...voterStakes.map((v) => v.option),
    ]);
    const options: OptionStake[] = [...optionKeys]
      .sort((a, b) => a - b)
      .map((option) => {
        const optionVoters = voterStakes.filter((v) => v.option === option);
        const stake = optionVoters.reduce(
          (sum, v) => sum.plus(v.stake),
          new BigNumber(0),
        );
        return {
          option,
          label: labels.get(option),
          stake: stake.toFixed(),
          percentage: totalStake.isZero()
            ? '0.00'
            : stake.div(totalStake).times(100).toFixed(2),
          votes: optionVoters.length,
        };
      });

    return {
      poll_address: pollAddress,
      height,
      closed,
      total_stake: totalStake.toFixed(),
      votes_count: voterStakes.length,
      options,
      voters: voterStakes.sort((a, b) =>
        new BigNumber(b.stake).comparedTo(a.stake),
      ),
    };
  }

  async getDelegatedPower(
    accountAddress: string,
    pollAddress?: string,
  ): Promise<DelegatedPowerResult> {
    let height = await this.aeSdkService.sdk.getHeight();
    let closed = false;
    let voters = new Set<string>();

    if (pollAddress) {
      const poll = await this.pollRepository.findOne({
        where: { poll_address: pollAddress },
      });
      if (!poll) {
        throw new NotFoundException(
          `Poll with address ${pollAddress} not found`,
        );
      }
      ({ closed, height } = pollHeight(poll, height));
      const votes = await this.voteRepository.find({
        where: { poll_address: pollAddress },
      });
      voters = new Set(resolveLatestVotes(votes as any, height).keys());
    }

    const active = await this.loadActiveDelegations(height);

    // Everyone whose chain reaches this account before any other voter
    // (delegators who voted in the poll themselves keep their power). The
    // account itself is skipped so a cycle back to it doesn't list it as its
    // own delegator.
    const stopAt = new Set([...voters, accountAddress]);
    const delegators = [...active.keys()].filter(
      (delegator) =>
        delegator !== accountAddress &&
        !voters.has(delegator) &&
        resolveDelegationTarget(delegator, active, stopAt) === accountAddress,
    );

    const balances = await this.getBalances(
      [accountAddress, ...delegators],
      closed ? height : undefined,
    );
    const balance = balances.get(accountAddress) ?? new BigNumber(0);
    const delegated = delegators.reduce(
      (sum, d) => sum.plus(balances.get(d) ?? 0),
      new BigNumber(0),
    );

    return {
      account: accountAddress,
      height,
      delegatee: active.get(accountAddress) ?? null,
      balance: balance.toFixed(),
      delegated_power: delegated.toFixed(),
      total_power: balance.plus(delegated).toFixed(),
      delegators,
    };
  }

  private async loadActiveDelegations(
    height: number,
  ): Promise<Map<string, string>> {
    const where = { block_height: LessThanOrEqual(height) };
    const [delegations, revocations] = await Promise.all([
      this.delegationRepository.find({ where }),
      this.revokedDelegationRepository.find({ where }),
    ]);
    return resolveActiveDelegations(
      delegations as any,
      revocations as any,
      height,
    );
  }

  /**
   * AE balances at `height`, or at the latest state when it is undefined.
   * Open polls use the latest state: asking for the current height can reach
   * a node one block behind, which answers 404 "Height not available".
   * Lookup failures propagate, so a node outage never reads as zero stake.
   */
  private async getBalances(
    accounts: string[],
    height: number | undefined,
  ): Promise<Map<string, BigNumber>> {
    const unique = [...new Set(accounts)];
    const result = new Map<string, BigNumber>();
    for (let i = 0; i < unique.length; i += BALANCE_CONCURRENCY) {
      const batch = unique.slice(i, i + BALANCE_CONCURRENCY);
      const values = await Promise.all(
        batch.map((account) =>
          this.aeSdkService.sdk.getBalance(
            account as Encoded.AccountAddress,
            { height, format: AE_AMOUNT_FORMATS.AE } as any,
          ),
        ),
      );
      batch.forEach((account, idx) =>
        result.set(account, new BigNumber(values[idx])),
      );
    }
    return result;
  }
}
