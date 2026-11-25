import { CACHE_MANAGER, CacheModule } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { Account } from '@/account/entities/account.entity';
import { AccountService } from '@/account/services/account.service';
import { AccountsController } from '@/account/controllers/accounts.controller';
import { BclPnlService } from '@/account/services/bcl-pnl.service';
import { PortfolioService } from '@/account/services/portfolio.service';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { fetchJson, FetchJsonHttpError } from '@/utils/common';
import { ProfileCache } from '../entities/profile-cache.entity';
import { ProfileChainNameClaim } from '../entities/profile-chain-name-claim.entity';
import { ProfileChainNameChallenge } from '../entities/profile-chain-name-challenge.entity';
import { ProfileChainNameService } from './profile-chain-name.service';
import { ProfileReadService } from './profile-read.service';

jest.mock('@/utils/common', () => ({
  ...jest.requireActual('@/utils/common'),
  fetchJson: jest.fn(),
}));

const describeWithDb = process.env.DB_HOST ? describe : describe.skip;
const ADDRESS = 'ak_3yT4BoLMWVWtCEpbb3Sv3ArtetmR5kVMDANpFsezXpqHBiFGQ';
const NAME = 'freshsponsored.chain';
const SPONSOR = 'ak_sponsor';

// Real Postgres transactions and HTTP/cache middleware. Only the chain and
// unrelated trading/social dependencies are simulated; no wallet sends occur.
describeWithDb('sponsored name to public profile (integration)', () => {
  let db: IsolatedDb;
  let app: INestApplication;
  let claims: ProfileChainNameService;
  let accountService: AccountService;
  let owner: string;
  const update = jest.fn();
  const transfer = jest.fn();

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [
        Account,
        ProfileCache,
        ProfileChainNameClaim,
        ProfileChainNameChallenge,
      ],
      migrations: [],
    });
    await db.dataSource.synchronize();
    const accounts = db.dataSource.getRepository(Account);
    accountService = new AccountService(accounts, {
      query: async () => [],
    } as any);
    const profiles = new ProfileReadService(
      db.dataSource.getRepository(ProfileCache),
      accounts,
      { isConfigured: () => false } as any,
    );
    claims = new ProfileChainNameService(
      db.dataSource.getRepository(ProfileChainNameClaim),
      db.dataSource.getRepository(ProfileChainNameChallenge),
      db.dataSource,
      { sdk: {} } as any,
      {
        getRewardAccount: () => ({ address: SPONSOR }),
        enqueueSpend: async (_key: string, work: () => Promise<unknown>) =>
          work(),
      } as any,
    );
    const module = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [AccountsController],
      providers: [
        { provide: getRepositoryToken(Account), useValue: accounts },
        {
          provide: getRepositoryToken(TokenHolder),
          useValue: { count: async () => 0 },
        },
        { provide: PortfolioService, useValue: {} },
        { provide: BclPnlService, useValue: {} },
        { provide: AccountService, useValue: accountService },
        { provide: ProfileReadService, useValue: profiles },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    await app.get<Cache>(CACHE_MANAGER).clear();
    await db.dataSource.query('TRUNCATE accounts, profile_chain_name_claims');
    owner = SPONSOR;
    update.mockResolvedValue({ hash: 'th_update' });
    transfer.mockImplementation(async () => {
      owner = ADDRESS;
      return { hash: 'th_transfer' };
    });
    jest.spyOn(claims as any, 'sponsorCanPay').mockResolvedValue(true);
    jest
      .spyOn(claims as any, 'createNameInstance')
      .mockReturnValue({ update, transfer });
    jest
      .spyOn(claims as any, 'getNameStateIfPresent')
      .mockImplementation(async () => ({
        owner,
        pointers: [{ key: 'account_pubkey', id: ADDRESS }],
      }));
    (fetchJson as jest.Mock)
      .mockReset()
      .mockImplementation(async (url: string) => {
        if (url.endsWith('/names/pointees')) {
          return {
            data:
              owner === ADDRESS
                ? [
                    {
                      active: true,
                      name: NAME,
                      block_height: 100,
                      tx: {
                        pointers: [{ key: 'account_pubkey', id: ADDRESS }],
                      },
                    },
                  ]
                : [],
          };
        }
        if (url.endsWith(`/v3/names/${NAME}`)) {
          return {
            active: true,
            ownership: { current: owner },
            pointers: [{ key: 'account_pubkey', id: ADDRESS }],
          };
        }
        throw new FetchJsonHttpError('Account not found', 404);
      });
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const seedClaim = async (status: 'claimed' | 'completed' = 'claimed') => {
    await db.dataSource
      .getRepository(ProfileChainNameClaim)
      .save({ address: ADDRESS, name: NAME, status });
  };
  const profile = () =>
    request(app.getHttpServer()).get(`/api/accounts/${ADDRESS}`);
  const names = () =>
    request(app.getHttpServer())
      .get('/api/accounts/chain-names')
      .query({ addresses: ADDRESS });

  it('makes an unfunded recipient visible to a fresh visitor immediately after completion', async () => {
    await seedClaim();
    await profile().expect(404);
    expect((await names().expect(200)).body[ADDRESS]).toBeNull();

    await claims.processDueClaims();

    expect((await claims.getClaimStatus(ADDRESS)).status).toBe('completed');
    const result = await profile().expect(200);
    expect(result.body.public_name).toBe(NAME);
    expect(result.body.chain_name).toBe(NAME);
    expect((await names().expect(200)).body[ADDRESS]).toBe(NAME);
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('refreshes a previously read account without replacing links, moderation or other account data', async () => {
    await db.dataSource.getRepository(Account).save({
      address: ADDRESS,
      chain_name: 'previous.chain',
      chain_name_updated_at: new Date(),
      links: { bio: 'Keep this bio' },
      banned: true,
      total_invitation_count: 7,
    });
    expect((await profile().expect(200)).body.public_name).toBe(
      'previous.chain',
    );
    expect((await names().expect(200)).body[ADDRESS]).toBe('previous.chain');
    await seedClaim();

    await claims.processDueClaims();

    expect((await profile().expect(200)).body.public_name).toBe(NAME);
    expect((await names().expect(200)).body[ADDRESS]).toBe(NAME);
    expect(
      await db.dataSource
        .getRepository(Account)
        .findOneByOrFail({ address: ADDRESS }),
    ).toMatchObject({
      chain_name: NAME,
      links: { bio: 'Keep this bio' },
      banned: true,
      total_invitation_count: 7,
    });
  });

  it('recovers a previously completed name-only claim when its profile is opened', async () => {
    owner = ADDRESS;
    await seedClaim('completed');

    expect((await profile().expect(200)).body.public_name).toBe(NAME);
    expect((await names().expect(200)).body[ADDRESS]).toBe(NAME);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('rolls back the account if completion fails, then retries without another transfer', async () => {
    await seedClaim();
    await db.dataSource.query(
      "ALTER TABLE profile_chain_name_claims ADD CONSTRAINT reject_completion CHECK (status <> 'completed')",
    );
    try {
      await claims.processDueClaims();
      expect(await db.dataSource.getRepository(Account).count()).toBe(0);
      expect((await claims.getClaimStatus(ADDRESS)).status).toBe('claimed');
    } finally {
      await db.dataSource.query(
        'ALTER TABLE profile_chain_name_claims DROP CONSTRAINT reject_completion',
      );
    }
    await db.dataSource
      .getRepository(ProfileChainNameClaim)
      .update(ADDRESS, { next_retry_at: null });

    await claims.processDueClaims();

    expect((await claims.getClaimStatus(ADDRESS)).status).toBe('completed');
    expect((await profile().expect(200)).body.public_name).toBe(NAME);
    expect(update).toHaveBeenCalledTimes(1);
    expect(transfer).toHaveBeenCalledTimes(1);
  });
});
