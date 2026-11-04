import 'dotenv/config';
import { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { GovernancePoll } from './entities/governance-poll.view';
import { GovernancePollVote } from './entities/governance-poll-vote.view';
import { GovernanceDelegation } from './entities/governance-delegation.view';
import { GovernanceRevokedDelegation } from './entities/governance-revoked-delegation.view';
import {
  GovernancePollStatus,
  GovernanceVoteService,
} from './services/governance-vote.service';
import { GovernancePowerService } from './services/governance-power.service';

/**
 * Poll list and stake queries against the real governance views, seeded with
 * txs rows shaped like production. The views read unqualified `txs`, so this
 * uses a throwaway database rather than a schema. Skipped without a DB host.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const CURRENT_HEIGHT = 2000;
const CLOSED_POLL = 'ct_closed';
const OPEN_POLL = 'ct_open';
const ENDLESS_POLL = 'ct_endless';
const BALANCES: Record<string, string> = {
  ak_voter1: '10',
  ak_voter2: '20',
  ak_delegator1: '1',
  ak_delegator2: '2',
  ak_delegator3: '3',
};

let seq = 0;
async function insertTx(
  ds: DataSource,
  fn: string,
  blockHeight: number,
  data: Record<string, unknown>,
): Promise<void> {
  seq += 1;
  const microTime = blockHeight * 1000 + seq;
  await ds.getRepository(Tx).save({
    hash: `th_${seq}`,
    block_hash: `mh_${blockHeight}`,
    block_height: blockHeight,
    micro_index: '0',
    micro_time: String(microTime),
    signatures: [],
    type: 'ContractCallTx',
    function: fn,
    raw: {},
    data: { governance: { _version: 2, data } },
    created_at: new Date(microTime),
  });
}

async function addPoll(
  ds: DataSource,
  pollAddress: string,
  blockHeight: number,
  author: string,
  closeHeight: number | null,
): Promise<void> {
  await insertTx(ds, 'add_poll', blockHeight, {
    author,
    metadata: { title: pollAddress, description: '', link: '', _spec_ref: [0] },
    poll_seq_id: String(blockHeight),
    poll_address: pollAddress,
    vote_options: [
      { key: 0, val: 'Yes' },
      { key: 1, val: 'No' },
    ],
    create_height: blockHeight,
    // The middleware decodes `option(int)` as `[1, h]` or `[0]`, and the sync
    // stores [0] as close_at_height and [1] as close_height.
    close_at_height: closeHeight == null ? 0 : 1,
    ...(closeHeight == null ? {} : { close_height: closeHeight }),
  });
}

async function seed(ds: DataSource): Promise<void> {
  await addPoll(ds, CLOSED_POLL, 1000, 'ak_alice', 1500);
  await addPoll(ds, OPEN_POLL, 1100, 'ak_bob', 2500);
  await addPoll(ds, ENDLESS_POLL, 1200, 'ak_alice', null);

  const vote = (voter: string, option: number) => ({
    voter,
    option,
    poll_address: CLOSED_POLL,
  });
  // Vote, revoke and re-vote within one height: only the last one counts.
  await insertTx(ds, 'vote', 1300, vote('ak_voter1', 0));
  await insertTx(ds, 'revoke_vote', 1300, {
    voter: 'ak_voter1',
    poll_address: CLOSED_POLL,
  });
  await insertTx(ds, 'vote', 1300, vote('ak_voter1', 1));
  await insertTx(ds, 'vote', 1310, vote('ak_voter2', 0));

  await insertTx(ds, 'delegate', 1400, {
    delegator: 'ak_delegator1',
    delegatee: 'ak_voter1',
  });
  // After the close height: counts now, but not for the closed poll.
  await insertTx(ds, 'delegate', 1600, {
    delegator: 'ak_delegator2',
    delegatee: 'ak_voter2',
  });
  // Revoked before the close height.
  await insertTx(ds, 'delegate', 1200, {
    delegator: 'ak_delegator3',
    delegatee: 'ak_voter2',
  });
  await insertTx(ds, 'revoke_delegation', 1450, {
    delegator: 'ak_delegator3',
  });
}

d('Governance views (integration)', () => {
  let db: IsolatedDb;
  let votes: GovernanceVoteService;
  let power: GovernancePowerService;
  const getBalance = jest.fn();

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [
        Tx,
        GovernancePoll,
        GovernancePollVote,
        GovernanceDelegation,
        GovernanceRevokedDelegation,
      ],
      migrations: [],
    });
    await db.dataSource.synchronize();
    await seed(db.dataSource);

    const repo = <T extends ObjectLiteral>(entity: EntityTarget<T>) =>
      db.dataSource.getRepository(entity);
    const aeSdkService = {
      sdk: {
        getHeight: jest.fn().mockResolvedValue(CURRENT_HEIGHT),
        getBalance,
      },
    } as any;
    votes = new GovernanceVoteService(
      repo(GovernancePoll),
      repo(GovernancePollVote),
      aeSdkService,
    );
    power = new GovernancePowerService(
      repo(GovernancePoll),
      repo(GovernancePollVote),
      repo(GovernanceDelegation),
      repo(GovernanceRevokedDelegation),
      aeSdkService,
    );
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(() => {
    getBalance.mockReset();
    getBalance.mockImplementation(
      async (account: string) => BALANCES[account] ?? '0',
    );
  });

  const list = async (filter: {
    status?: GovernancePollStatus;
    author?: string;
  }) =>
    (await votes.findAll({ page: 1, limit: 10 }, filter)).items.map(
      (poll) => poll.poll_address,
    );

  it('filters polls by close height and author, newest first', async () => {
    expect(await list({})).toEqual([ENDLESS_POLL, OPEN_POLL, CLOSED_POLL]);
    expect(await list({ status: GovernancePollStatus.Open })).toEqual([
      ENDLESS_POLL,
      OPEN_POLL,
    ]);
    expect(await list({ status: GovernancePollStatus.Closed })).toEqual([
      CLOSED_POLL,
    ]);
    expect(await list({ author: 'ak_alice' })).toEqual([
      ENDLESS_POLL,
      CLOSED_POLL,
    ]);
    expect(
      await list({ status: GovernancePollStatus.Open, author: 'ak_alice' }),
    ).toEqual([ENDLESS_POLL]);
  });

  it('weights a closed poll at its close height', async () => {
    const result = await power.getPollPower(CLOSED_POLL);

    expect(result).toMatchObject({
      closed: true,
      height: 1500,
      total_stake: '31',
      votes_count: 2,
      options: [
        { option: 0, label: 'Yes', stake: '20', percentage: '64.52', votes: 1 },
        { option: 1, label: 'No', stake: '11', percentage: '35.48', votes: 1 },
      ],
      voters: [
        { account: 'ak_voter2', stake: '20', delegators: [] },
        { account: 'ak_voter1', stake: '11', delegators: ['ak_delegator1'] },
      ],
    });
    for (const [, options] of getBalance.mock.calls) {
      expect(options).toMatchObject({ height: 1500 });
    }
  });

  it('reports delegated power at the latest state', async () => {
    const result = await power.getDelegatedPower('ak_voter2');

    expect(result).toMatchObject({
      height: CURRENT_HEIGHT,
      delegators: ['ak_delegator2'],
      total_power: '22',
    });
    for (const [, options] of getBalance.mock.calls) {
      expect(options.height).toBeUndefined();
    }
  });
});
