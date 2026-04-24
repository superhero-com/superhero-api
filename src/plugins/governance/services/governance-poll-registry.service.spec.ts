import { GovernancePollRegistry } from './governance-poll-registry.service';

type QueryBuilderMock = {
  select: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  distinct: jest.Mock;
  getRawMany: jest.Mock;
};

function buildQueryBuilder(
  rows: Array<{ poll_address: string | null }> | Error,
): QueryBuilderMock {
  const qb: QueryBuilderMock = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    distinct: jest.fn().mockReturnThis(),
    getRawMany:
      rows instanceof Error
        ? jest.fn().mockRejectedValue(rows)
        : jest.fn().mockResolvedValue(rows),
  };
  return qb;
}

describe('GovernancePollRegistry', () => {
  function setup(rows: Array<{ poll_address: string | null }> | Error = []) {
    const qb = buildQueryBuilder(rows);
    const txRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as any;

    const registry = new GovernancePollRegistry(txRepository);
    return { registry, txRepository, qb };
  }

  it('seeds the known-poll set from existing add_poll data on module init', async () => {
    const { registry } = setup([
      { poll_address: 'ct_pollA' },
      { poll_address: 'ct_pollB' },
      { poll_address: null },
    ]);

    await registry.onModuleInit();

    expect(registry.size()).toBe(2);
    expect(registry.has('ct_pollA')).toBe(true);
    expect(registry.has('ct_pollB')).toBe(true);
    expect(registry.has('ct_pollC')).toBe(false);
    expect(registry.isLoaded()).toBe(true);
  });

  it('tolerates a DB failure at startup and keeps the set empty', async () => {
    const { registry } = setup(new Error('boom'));

    await expect(registry.onModuleInit()).resolves.toBeUndefined();

    expect(registry.size()).toBe(0);
    expect(registry.isLoaded()).toBe(false);
    expect(registry.has('ct_pollA')).toBe(false);
  });

  it('register() adds new poll addresses idempotently and reports newness', () => {
    const { registry } = setup();

    expect(registry.register('ct_newPoll')).toBe(true);
    expect(registry.register('ct_newPoll')).toBe(false);
    expect(registry.register('ct_otherPoll')).toBe(true);

    expect(registry.size()).toBe(2);
    expect(registry.has('ct_newPoll')).toBe(true);
    expect(registry.has('ct_otherPoll')).toBe(true);
  });

  it('register() ignores empty / nullish inputs and reports false', () => {
    const { registry } = setup();

    expect(registry.register('')).toBe(false);
    expect(registry.register(null)).toBe(false);
    expect(registry.register(undefined)).toBe(false);

    expect(registry.size()).toBe(0);
  });

  it('register() returns false for polls pre-seeded from the DB', async () => {
    const { registry } = setup([{ poll_address: 'ct_seeded' }]);
    await registry.onModuleInit();

    expect(registry.register('ct_seeded')).toBe(false);
    expect(registry.register('ct_brandNew')).toBe(true);
  });

  it('has() returns false for empty / nullish inputs', () => {
    const { registry } = setup();
    registry.register('ct_pollA');

    expect(registry.has('')).toBe(false);
    expect(registry.has(null)).toBe(false);
    expect(registry.has(undefined)).toBe(false);
    expect(registry.has('ct_pollA')).toBe(true);
  });
});
