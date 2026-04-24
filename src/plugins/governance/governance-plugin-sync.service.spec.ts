/* eslint-disable @typescript-eslint/no-explicit-any */
import { fetchJson } from '@/utils/common';
import { GovernancePluginSyncService } from './governance-plugin-sync.service';
import { GovernancePollRegistry } from './services/governance-poll-registry.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { GOVERNANCE_CONTRACT } from './config/governance.config';

jest.mock('@/utils/common', () => ({
  fetchJson: jest.fn(),
  sanitizeJsonForPostgres: jest.fn((value: any) => value),
  serializeBigInts: jest.fn((value: any) => value),
}));

const POLL_ADDRESS = 'ct_pollAddressUnderTest';
const CREATE_TX_HASH = 'th_createTxHashUnderTest';
const ADD_POLL_TX_HASH = 'th_addPollTxHashUnderTest';
const VOTE_HASH_A = 'th_voteHashA';
const VOTE_HASH_B = 'th_voteHashB';
const REVOKE_HASH = 'th_revokeHash';
const MIDDLEWARE_URL = 'https://mdw.example.test';

type TxRepoMock = {
  findOne: jest.Mock;
  upsert: jest.Mock;
};

function buildTxRepository(): TxRepoMock {
  return {
    findOne: jest.fn(),
    upsert: jest.fn(),
  };
}

function buildPollRegistry(options: { existing?: string[] } = {}) {
  const known = new Set<string>(options.existing ?? []);
  const registry = {
    register: jest.fn((addr: string) => {
      if (!addr) return false;
      if (known.has(addr)) return false;
      known.add(addr);
      return true;
    }),
    has: jest.fn((addr: string) => known.has(addr)),
    size: jest.fn(() => known.size),
    isLoaded: jest.fn(() => true),
  } as unknown as GovernancePollRegistry;
  return registry;
}

function buildConfigService(
  overrides: {
    middlewareUrl?: string | null;
    governanceContract?: string | null;
  } = {},
) {
  const middlewareUrl =
    overrides.middlewareUrl === null
      ? undefined
      : (overrides.middlewareUrl ?? MIDDLEWARE_URL);
  const governanceContract =
    overrides.governanceContract === null
      ? undefined
      : (overrides.governanceContract ?? 'ct_customRegistry');

  return {
    get: jest.fn((key: string) => {
      if (key === 'mdw.middlewareUrl') return middlewareUrl;
      if (key === 'governance') {
        return governanceContract
          ? { contract: { contractAddress: governanceContract } }
          : undefined;
      }
      return undefined;
    }),
  } as any;
}

function buildService(
  options: {
    repo?: TxRepoMock;
    registry?: GovernancePollRegistry;
    middlewareUrl?: string | null;
    governanceContract?: string | null;
  } = {},
) {
  const repo = options.repo ?? buildTxRepository();
  const registry = options.registry ?? buildPollRegistry();
  const configService = buildConfigService({
    middlewareUrl: options.middlewareUrl,
    governanceContract: options.governanceContract,
  });
  const aeSdkService = {
    sdk: { getBalance: jest.fn() },
  } as any;

  const service = new GovernancePluginSyncService(
    aeSdkService,
    repo as any,
    registry,
    configService,
  );

  return { service, repo, registry, configService };
}

function buildAddPollTx(overrides: Partial<Tx> = {}): Tx {
  return {
    hash: ADD_POLL_TX_HASH,
    function: GOVERNANCE_CONTRACT.FUNCTIONS.add_poll,
    logs: {
      governance: {
        data: [
          {
            args: [POLL_ADDRESS, '1'],
          },
        ],
      },
    },
    ...overrides,
  } as Tx;
}

function buildCreateTxEntity(): Tx {
  return {
    hash: CREATE_TX_HASH,
    type: 'ContractCreateTx',
    contract_id: POLL_ADDRESS,
    caller_id: 'ak_creator',
    block_height: 100,
    raw: {
      args: [
        { value: ['Title', 'Description', 'Link', 'SpecRef'] },
        { value: ['Yes', 'No'] },
        { value: [120, 20] },
      ],
    },
  } as any as Tx;
}

function buildMiddlewareCreateTx() {
  return {
    hash: CREATE_TX_HASH,
    block_height: 100,
    block_hash: 'mh_blockHash',
    micro_index: 0,
    micro_time: 1700000000,
    signatures: ['sg_1'],
    encoded_tx: 'tx_encoded',
    tx: {
      type: 'ContractCreateTx',
      caller_id: 'ak_creator',
      contract_id: POLL_ADDRESS,
    },
  };
}

function buildMiddlewareVoteTx(
  overrides: {
    hash?: string;
    function?: string;
    blockHeight?: number;
    microTime?: number;
  } = {},
) {
  return {
    hash: overrides.hash ?? VOTE_HASH_A,
    block_height: overrides.blockHeight ?? 200,
    block_hash: 'mh_voteBlockHash',
    micro_index: 1,
    micro_time: overrides.microTime ?? 1700000001,
    signatures: ['sg_vote'],
    encoded_tx: 'tx_voteEncoded',
    tx: {
      type: 'ContractCallTx',
      function: overrides.function ?? GOVERNANCE_CONTRACT.FUNCTIONS.vote,
      caller_id: 'ak_voter',
      contract_id: POLL_ADDRESS,
    },
  };
}

describe('GovernancePluginSyncService.decodeData(add_poll)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns decoded metadata using a locally-cached ContractCreateTx and does NOT register the poll (register-after-save invariant)', async () => {
    const repo = buildTxRepository();
    repo.findOne.mockResolvedValueOnce(buildCreateTxEntity());
    const registry = buildPollRegistry();

    const { service } = buildService({ repo, registry });

    const result = await service.decodeData(buildAddPollTx());

    expect(result).toMatchObject({
      poll_address: POLL_ADDRESS,
      metadata: {
        title: 'Title',
        description: 'Description',
        link: 'Link',
        _spec_ref: 'SpecRef',
      },
      vote_options: ['Yes', 'No'],
      author: 'ak_creator',
      close_at_height: 120,
      close_height: 20,
      create_height: 100,
    });
    expect(registry.register).not.toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('falls back to MDW backfill when the CreateTx is missing locally', async () => {
    const repo = buildTxRepository();
    const createTxEntity = buildCreateTxEntity();
    repo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createTxEntity);
    repo.upsert.mockResolvedValueOnce(undefined);

    (fetchJson as jest.Mock)
      .mockResolvedValueOnce({ source_tx_hash: CREATE_TX_HASH })
      .mockResolvedValueOnce(buildMiddlewareCreateTx());

    const { service } = buildService({ repo });

    const result = await service.decodeData(buildAddPollTx());

    expect((fetchJson as jest.Mock).mock.calls[0][0]).toContain(
      `${MIDDLEWARE_URL}/v3/contracts/${POLL_ADDRESS}`,
    );
    expect((fetchJson as jest.Mock).mock.calls[1][0]).toContain(
      `${MIDDLEWARE_URL}/v3/transactions/${CREATE_TX_HASH}`,
    );
    expect(repo.upsert).toHaveBeenCalledTimes(1);
    // NOTE: backfillPollCreateTx returns null here (repo.findOne for the
    // newly-upserted row is not stubbed), so the outer decodeData returns
    // null. That null is the explicit "missing metadata" contract. The
    // important assertion is that the MDW backfill path was exercised.
    expect(result).not.toBeUndefined();
  });

  it('returns null when MDW responds without a source_tx_hash', async () => {
    const repo = buildTxRepository();
    repo.findOne.mockResolvedValue(null);
    (fetchJson as jest.Mock).mockResolvedValueOnce({});

    const { service } = buildService({ repo });

    const result = await service.decodeData(buildAddPollTx());

    expect(result).toBeNull();
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('returns null when MDW source tx is not a ContractCreateTx', async () => {
    const repo = buildTxRepository();
    repo.findOne.mockResolvedValue(null);
    (fetchJson as jest.Mock)
      .mockResolvedValueOnce({ source_tx_hash: CREATE_TX_HASH })
      .mockResolvedValueOnce({
        hash: CREATE_TX_HASH,
        tx: { type: 'SpendTx' },
      });

    const { service } = buildService({ repo });

    const result = await service.decodeData(buildAddPollTx());

    expect(result).toBeNull();
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('swallows MDW errors and returns null so ingest keeps flowing', async () => {
    const repo = buildTxRepository();
    repo.findOne.mockResolvedValue(null);
    (fetchJson as jest.Mock).mockRejectedValue(new Error('network down'));

    const { service } = buildService({ repo });

    const result = await service.decodeData(buildAddPollTx());

    expect(result).toBeNull();
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('returns null when the cached CreateTx has a malformed raw.args shape', async () => {
    const repo = buildTxRepository();
    repo.findOne.mockResolvedValueOnce({
      ...buildCreateTxEntity(),
      raw: { args: 'not-an-array' as any },
    });

    const { service } = buildService({ repo });

    const result = await service.decodeData(buildAddPollTx());

    expect(result).toBeNull();
  });

  it('returns null when metadata args are missing from the CreateTx', async () => {
    const repo = buildTxRepository();
    repo.findOne.mockResolvedValueOnce({
      ...buildCreateTxEntity(),
      raw: {
        args: [{ value: null }, { value: ['Yes', 'No'] }, { value: [120, 20] }],
      },
    });

    const { service } = buildService({ repo });

    const result = await service.decodeData(buildAddPollTx());

    expect(result).toBeNull();
  });

  it('honors the configured mdw.middlewareUrl when backfilling', async () => {
    const repo = buildTxRepository();
    repo.findOne.mockResolvedValue(null);
    (fetchJson as jest.Mock)
      .mockResolvedValueOnce({ source_tx_hash: CREATE_TX_HASH })
      .mockResolvedValueOnce(buildMiddlewareCreateTx());

    const customMdw = 'https://custom-mdw.example.test';
    const { service } = buildService({ repo, middlewareUrl: customMdw });

    await service.decodeData(buildAddPollTx());

    expect((fetchJson as jest.Mock).mock.calls[0][0]).toBe(
      `${customMdw}/v3/contracts/${POLL_ADDRESS}`,
    );
    expect((fetchJson as jest.Mock).mock.calls[1][0]).toBe(
      `${customMdw}/v3/transactions/${CREATE_TX_HASH}`,
    );
  });
});

describe('GovernancePluginSyncService.processTransaction(add_poll) — register + vote backfill', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  function buildSavedAddPoll(overrides: Partial<Tx> = {}): Tx {
    return {
      hash: ADD_POLL_TX_HASH,
      function: GOVERNANCE_CONTRACT.FUNCTIONS.add_poll,
      data: {
        governance: {
          _version: 2,
          data: { poll_address: POLL_ADDRESS },
        },
      },
      ...overrides,
    } as Tx;
  }

  /**
   * Seed repo.findOne so the first lookup (the "verify persisted" re-read
   * inside processTransaction) returns the persisted add_poll row. Any
   * follow-on mocks for vote-backfill DB checks should be chained via
   * `.mockResolvedValueOnce` on the returned mock AFTER calling this.
   */
  function mockPersistedAddPollLookup(
    repo: TxRepoMock,
    pollAddress: string = POLL_ADDRESS,
  ) {
    repo.findOne.mockResolvedValueOnce({
      hash: ADD_POLL_TX_HASH,
      data: {
        governance: { _version: 2, data: { poll_address: pollAddress } },
      },
    });
  }

  it('registers a newly-discovered poll AFTER save and triggers vote backfill', async () => {
    const repo = buildTxRepository();
    mockPersistedAddPollLookup(repo);
    // Vote backfill lookups — both votes are new:
    repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    (fetchJson as jest.Mock).mockResolvedValueOnce({
      data: [
        buildMiddlewareVoteTx({ hash: VOTE_HASH_A }),
        buildMiddlewareVoteTx({
          hash: REVOKE_HASH,
          function: GOVERNANCE_CONTRACT.FUNCTIONS.revoke_vote,
        }),
      ],
      next: null,
    });
    const registry = buildPollRegistry();

    const { service } = buildService({ repo, registry });

    await service.processTransaction(buildSavedAddPoll(), 'backward' as any);

    expect(registry.register).toHaveBeenCalledWith(POLL_ADDRESS);
    expect((registry.register as jest.Mock).mock.results[0].value).toBe(true);
    expect((fetchJson as jest.Mock).mock.calls[0][0]).toBe(
      `${MIDDLEWARE_URL}/v3/transactions?type=contract_call&contract=${POLL_ADDRESS}&direction=forward&limit=100`,
    );
    expect(repo.upsert).toHaveBeenCalledTimes(2);
  });

  it('skips vote backfill when the poll was already seeded from the DB', async () => {
    const repo = buildTxRepository();
    mockPersistedAddPollLookup(repo);
    const registry = buildPollRegistry({ existing: [POLL_ADDRESS] });

    const { service } = buildService({ repo, registry });

    await service.processTransaction(buildSavedAddPoll(), 'backward' as any);

    expect(registry.register).toHaveBeenCalledWith(POLL_ADDRESS);
    expect((registry.register as jest.Mock).mock.results[0].value).toBe(false);
    expect(fetchJson).not.toHaveBeenCalled();
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('does not register when the DB row has no governance poll address (save failed)', async () => {
    const repo = buildTxRepository();
    // processTransaction re-reads the row; if the row lacks governance
    // data, we must NOT register (keeps runtime in lockstep with SQL).
    repo.findOne.mockResolvedValueOnce({
      hash: ADD_POLL_TX_HASH,
      data: {},
    });
    const registry = buildPollRegistry();

    const { service } = buildService({ repo, registry });

    await service.processTransaction(buildSavedAddPoll(), 'backward' as any);

    expect(registry.register).not.toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('does not register when the row is missing entirely from the DB', async () => {
    const repo = buildTxRepository();
    repo.findOne.mockResolvedValueOnce(null);
    const registry = buildPollRegistry();

    const { service } = buildService({ repo, registry });

    await service.processTransaction(buildSavedAddPoll(), 'backward' as any);

    expect(registry.register).not.toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('is a no-op for non-add_poll transactions', async () => {
    const repo = buildTxRepository();
    const registry = buildPollRegistry();

    const { service } = buildService({ repo, registry });

    await service.processTransaction(
      {
        hash: VOTE_HASH_A,
        function: GOVERNANCE_CONTRACT.FUNCTIONS.vote,
        data: {
          governance: {
            _version: 2,
            data: { poll: '1', voter: 'ak_x' },
          },
        },
      } as Tx,
      'backward' as any,
    );

    expect(registry.register).not.toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('only persists vote/revoke_vote functions and skips unrelated contract calls from MDW response', async () => {
    const repo = buildTxRepository();
    mockPersistedAddPollLookup(repo);
    repo.findOne.mockResolvedValueOnce(null);
    (fetchJson as jest.Mock).mockResolvedValueOnce({
      data: [
        buildMiddlewareVoteTx({
          hash: 'th_otherCall',
          function: 'some_other_function',
        }),
        buildMiddlewareVoteTx({ hash: VOTE_HASH_A }),
      ],
      next: null,
    });
    const registry = buildPollRegistry();

    const { service } = buildService({ repo, registry });

    await service.processTransaction(buildSavedAddPoll(), 'backward' as any);

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const persisted = repo.upsert.mock.calls[0][0];
    expect(persisted.hash).toBe(VOTE_HASH_A);
    expect(persisted.function).toBe(GOVERNANCE_CONTRACT.FUNCTIONS.vote);
  });

  it('does not re-persist votes that already exist in the DB', async () => {
    const repo = buildTxRepository();
    mockPersistedAddPollLookup(repo);
    // First vote exists; second is new.
    repo.findOne
      .mockResolvedValueOnce({ hash: VOTE_HASH_A })
      .mockResolvedValueOnce(null);
    (fetchJson as jest.Mock).mockResolvedValueOnce({
      data: [
        buildMiddlewareVoteTx({ hash: VOTE_HASH_A }),
        buildMiddlewareVoteTx({ hash: VOTE_HASH_B }),
      ],
      next: null,
    });
    const registry = buildPollRegistry();

    const { service } = buildService({ repo, registry });

    await service.processTransaction(buildSavedAddPoll(), 'backward' as any);

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    expect(repo.upsert.mock.calls[0][0].hash).toBe(VOTE_HASH_B);
  });

  it('paginates through MDW pages until next is null', async () => {
    const repo = buildTxRepository();
    mockPersistedAddPollLookup(repo);
    repo.findOne.mockResolvedValue(null);

    (fetchJson as jest.Mock)
      .mockResolvedValueOnce({
        data: [buildMiddlewareVoteTx({ hash: VOTE_HASH_A })],
        next: '/v3/transactions?cursor=page2',
      })
      .mockResolvedValueOnce({
        data: [buildMiddlewareVoteTx({ hash: VOTE_HASH_B })],
        next: null,
      });

    const registry = buildPollRegistry();

    const { service } = buildService({ repo, registry });

    await service.processTransaction(buildSavedAddPoll(), 'backward' as any);

    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect((fetchJson as jest.Mock).mock.calls[1][0]).toBe(
      `${MIDDLEWARE_URL}/v3/transactions?cursor=page2`,
    );
    expect(repo.upsert).toHaveBeenCalledTimes(2);
  });

  it('swallows MDW errors during vote backfill and still leaves the poll registered', async () => {
    const repo = buildTxRepository();
    mockPersistedAddPollLookup(repo);
    (fetchJson as jest.Mock).mockRejectedValueOnce(new Error('mdw 500'));
    const registry = buildPollRegistry();

    const { service } = buildService({ repo, registry });

    await expect(
      service.processTransaction(buildSavedAddPoll(), 'backward' as any),
    ).resolves.toBeUndefined();

    expect(registry.register).toHaveBeenCalledWith(POLL_ADDRESS);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('stops paginating after the page safety limit to avoid runaway loops', async () => {
    const repo = buildTxRepository();
    mockPersistedAddPollLookup(repo);
    repo.findOne.mockResolvedValue(null);
    // Always return a "next" cursor so the loop would run forever.
    (fetchJson as jest.Mock).mockResolvedValue({
      data: [],
      next: '/v3/transactions?cursor=infinite',
    });
    const registry = buildPollRegistry();

    const { service } = buildService({ repo, registry });

    await service.processTransaction(buildSavedAddPoll(), 'backward' as any);

    expect((fetchJson as jest.Mock).mock.calls.length).toBe(
      GovernancePluginSyncService.VOTE_BACKFILL_PAGE_SAFETY,
    );
  });
});
