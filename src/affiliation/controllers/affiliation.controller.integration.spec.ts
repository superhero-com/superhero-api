import 'dotenv/config';
import { ConflictException } from '@nestjs/common';
import { IsNull, Not, Repository } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Affiliation } from '../entities/affiliation.entity';
import { AffiliationCode } from '../entities/affiliation-code.entity';
import { AffiliationController } from './affiliation.controller';

/**
 * Runs invite claims against real Postgres, because the guarantees under test
 * (one code per user, never one code for two users) only hold under
 * concurrency. Skipped automatically when no DB host is set.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

d('AffiliationController.getRewardCode (integration)', () => {
  let db: IsolatedDb;
  let affiliations: Repository<Affiliation>;
  let codes: Repository<AffiliationCode>;
  let controller: AffiliationController;

  // The access token doubles as the provider's user id.
  const claim = (link: string, provider: string, user: string) =>
    controller
      .getRewardCode(link, provider, user)
      .then((result) => result.invitationCode.private_code);

  const seed = async (link: string, count: number) => {
    const affiliation = await affiliations.save(
      affiliations.create({ account_address: 'ak_inviter', code: link }),
    );
    await codes.save(
      Array.from({ length: count }, (_, i) =>
        codes.create({ affiliation, private_code: `${link}_sk_${i + 1}` }),
      ),
    );
  };

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [Affiliation, AffiliationCode],
      migrations: [],
    });
    await db.dataSource.synchronize();
    affiliations = db.dataSource.getRepository(Affiliation);
    codes = db.dataSource.getRepository(AffiliationCode);
    controller = new AffiliationController(affiliations, codes, {
      verifyAccessToken: async (_provider: string, token: string) => ({
        id: token,
      }),
    } as any);
  }, 60_000);

  beforeEach(async () => {
    await db.dataSource.query(
      'TRUNCATE "affiliation_codes", "affiliations" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  it('gives one user exactly one code however many requests run at once', async () => {
    await seed('link1', 20);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => claim('link1', 'x', 'u1')),
    );

    expect(new Set(results).size).toBe(1);
    expect(await codes.count()).toBe(20);
    expect(await codes.findBy({ claimed_by: Not(IsNull()) })).toEqual([
      expect.objectContaining({
        private_code: results[0],
        claimed_by: 'x@u1',
        claimed_at: expect.any(Date),
      }),
    ]);
  });

  it('never gives the same code to two users claiming at once', async () => {
    await seed('link1', 10);

    const results = await Promise.allSettled(
      Array.from({ length: 11 }, (_, i) => claim('link1', 'x', `u${i}`)),
    );

    const handedOut = results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<string>).value);
    const refused = results.filter((r) => r.status === 'rejected');
    expect(new Set(handedOut).size).toBe(10);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );
    expect(await codes.countBy({ claimed_by: Not(IsNull()) })).toBe(10);
  });

  it('treats every spelling of the provider as the same user', async () => {
    await seed('link1', 5);

    const results = [
      await claim('link1', 'github', 'u1'),
      await claim('link1', 'GitHub', 'u1'),
      await claim('link1', 'GITHUB', 'u1'),
    ];

    expect(new Set(results).size).toBe(1);
    expect(await codes.findBy({ claimed_by: Not(IsNull()) })).toEqual([
      expect.objectContaining({ claimed_by: 'github@u1' }),
    ]);
  });

  it('recognises a returning user whatever the case of their id', async () => {
    await seed('link1', 5);

    const first = await claim('link1', 'x', 'U1');

    expect(await claim('link1', 'x', 'U1')).toBe(first);
    expect(await codes.countBy({ claimed_by: Not(IsNull()) })).toBe(1);
  });

  it('honours a claim stored with a mixed-case provider', async () => {
    await seed('link1', 5);
    await codes.update(
      { private_code: 'link1_sk_3' },
      { claimed_by: 'GitHub@u1' },
    );

    expect(await claim('link1', 'github', 'u1')).toBe('link1_sk_3');
    expect(await codes.countBy({ claimed_by: Not(IsNull()) })).toBe(1);
  });

  it('never hands out a code assigned before claimed_at was written', async () => {
    await seed('link1', 2);
    await codes.update(
      { private_code: 'link1_sk_1' },
      { claimed_by: 'x@old-user' },
    );

    expect(await claim('link1', 'x', 'u1')).toBe('link1_sk_2');
    await expect(claim('link1', 'x', 'u2')).rejects.toThrow(ConflictException);
    expect(await codes.findOneBy({ private_code: 'link1_sk_1' })).toEqual(
      expect.objectContaining({ claimed_by: 'x@old-user', claimed_at: null }),
    );
  });

  it('refuses a second claim on another link', async () => {
    await seed('link1', 2);
    await seed('link2', 2);

    await claim('link1', 'x', 'u1');

    await expect(claim('link2', 'x', 'u1')).rejects.toThrow(
      'User already claimed a code',
    );
    expect(await codes.count()).toBe(4);
    expect(await codes.countBy({ claimed_by: Not(IsNull()) })).toBe(1);
  });
});
