import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AE_AMOUNT_FORMATS } from '@aeternity/aepp-sdk';
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
const CLOSED_CACHE_LIMIT = 200;

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
 * Stake-weighted governance numbers (#306): per-option stake, total vote
 * power and delegated power, computed from indexed votes/delegations plus
 * on-chain AE balances at the poll height (close height for closed polls,
 * the current height for open ones).
 */
@Injectable()
export class GovernancePowerService {
  private readonly logger = new Logger(GovernancePowerService.name);
  private readonly closedPollCache = new Map<string, PollPowerResult>();

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
    const cached = this.closedPollCache.get(pollAddress);
    if (cached) {
      return cached;
    }

    const poll = await this.pollRepository.findOne({
      where: { poll_address: pollAddress },
    });
    if (!poll) {
      throw new NotFoundException(`Poll with address ${pollAddress} not found`);
    }

    const currentHeight = await this.aeSdkService.sdk.getHeight();
    const closeAt = poll.close_at_height ?? poll.close_height ?? null;
    const closed = closeAt != null && closeAt <= currentHeight;
    const height = closed ? closeAt : currentHeight;

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
    const balances = await this.getBalances(accounts, height);

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
            ? '0'
            : stake.div(totalStake).times(100).toFixed(2),
          votes: optionVoters.length,
        };
      });

    const result: PollPowerResult = {
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

    if (closed) {
      if (this.closedPollCache.size >= CLOSED_CACHE_LIMIT) {
        const oldest = this.closedPollCache.keys().next().value;
        if (oldest) this.closedPollCache.delete(oldest);
      }
      this.closedPollCache.set(pollAddress, result);
    }
    return result;
  }

  async getDelegatedPower(
    accountAddress: string,
    pollAddress?: string,
  ): Promise<DelegatedPowerResult> {
    let height = await this.aeSdkService.sdk.getHeight();
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
      const closeAt = poll.close_at_height ?? poll.close_height ?? null;
      if (closeAt != null && closeAt <= height) height = closeAt;
      const votes = await this.voteRepository.find({
        where: { poll_address: pollAddress },
      });
      voters = new Set(resolveLatestVotes(votes as any, height).keys());
    }

    const active = await this.loadActiveDelegations(height);

    // Everyone whose chain passes through this account, stopping at
    // delegators who voted in the poll themselves (they keep their power).
    const delegators: string[] = [];
    for (const delegator of active.keys()) {
      if (delegator === accountAddress || voters.has(delegator)) continue;
      const seen = new Set<string>([delegator]);
      let current = active.get(delegator);
      while (current && !seen.has(current)) {
        if (current === accountAddress) {
          delegators.push(delegator);
          break;
        }
        if (voters.has(current)) break;
        seen.add(current);
        current = active.get(current);
      }
    }

    const balances = await this.getBalances(
      [accountAddress, ...delegators],
      height,
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
    const [delegations, revocations] = await Promise.all([
      this.delegationRepository.find(),
      this.revokedDelegationRepository.find(),
    ]);
    return resolveActiveDelegations(
      delegations as any,
      revocations as any,
      height,
    );
  }

  private async getBalances(
    accounts: string[],
    height: number,
  ): Promise<Map<string, BigNumber>> {
    const unique = [...new Set(accounts)];
    const result = new Map<string, BigNumber>();
    for (let i = 0; i < unique.length; i += BALANCE_CONCURRENCY) {
      const batch = unique.slice(i, i + BALANCE_CONCURRENCY);
      const values = await Promise.all(
        batch.map(async (account) => {
          try {
            const balance = await this.aeSdkService.sdk.getBalance(
              account as any,
              { height, format: AE_AMOUNT_FORMATS.AE } as any,
            );
            return new BigNumber(balance);
          } catch (error) {
            this.logger.warn(
              `Balance lookup failed for ${account} at ${height}: ${(error as Error)?.message}`,
            );
            return new BigNumber(0);
          }
        }),
      );
      batch.forEach((account, idx) => result.set(account, values[idx]));
    }
    return result;
  }
}
