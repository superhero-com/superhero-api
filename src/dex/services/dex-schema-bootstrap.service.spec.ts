import { Logger } from '@nestjs/common';
import { DexSchemaBootstrapService } from './dex-schema-bootstrap.service';

describe('DexSchemaBootstrapService', () => {
  const makeService = (query: jest.Mock) => {
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query,
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    };
    return {
      service: new DexSchemaBootstrapService(dataSource as any),
      queryRunner,
    };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs every required and index statement on init', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService(query);

    await service.onModuleInit();

    const executed = query.mock.calls.map((call) => call[0] as string);
    for (const statement of DexSchemaBootstrapService.STATEMENTS) {
      expect(executed).toContain(statement);
    }
  });

  it('ensures the listed column and pair-history index idempotently', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService(query);

    await service.onModuleInit();

    const executed = query.mock.calls.map((call) => call[0] as string);
    expect(
      executed.some(
        (sql) =>
          /ALTER TABLE "dex_tokens"/.test(sql) &&
          /ADD COLUMN IF NOT EXISTS "listed"/.test(sql),
      ),
    ).toBe(true);
    expect(
      executed.some(
        (sql) =>
          /CREATE INDEX IF NOT EXISTS "IDX_pair_transactions_pair_created_at"/.test(
            sql,
          ) && /\("pair_address", "created_at"\)/.test(sql),
      ),
    ).toBe(true);
  });

  it('creates the new feed/FK/listed indexes', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService(query);

    await service.onModuleInit();

    const executed = query.mock.calls.map((call) => call[0] as string).join('\n');
    expect(executed).toMatch(/IDX_pair_transactions_created_at/);
    expect(executed).toMatch(/IDX_pair_transactions_tx_type/);
    expect(executed).toMatch(/IDX_pair_transactions_account_address/);
    expect(executed).toMatch(/IDX_pairs_token0_address/);
    expect(executed).toMatch(/IDX_pairs_token1_address/);
    expect(executed).toMatch(/IDX_dex_tokens_listed/);
  });

  it('serialises DDL behind an advisory lock and always releases it', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const { service, queryRunner } = makeService(query);

    await service.onModuleInit();

    const calls = query.mock.calls.map((call) => call[0] as string);
    expect(calls[0]).toMatch(/pg_advisory_lock/);
    expect(calls[calls.length - 1]).toMatch(/pg_advisory_unlock/);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('aborts startup when a REQUIRED statement fails (and still releases)', async () => {
    // First non-lock statement is the required `listed` column ALTER.
    const query = jest.fn().mockImplementation((sql: string) => {
      if (/ALTER TABLE "dex_tokens"/.test(sql)) {
        return Promise.reject(new Error('permission denied'));
      }
      return Promise.resolve(undefined);
    });
    const { service, queryRunner } = makeService(query);

    await expect(service.onModuleInit()).rejects.toThrow('permission denied');

    // Lock must be released and the connection returned even on failure.
    const calls = query.mock.calls.map((call) => call[0] as string);
    expect(calls.some((sql) => /pg_advisory_unlock/.test(sql))).toBe(true);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('continues (best-effort) when an INDEX statement fails', async () => {
    const query = jest.fn().mockImplementation((sql: string) => {
      if (/IDX_pair_transactions_created_at/.test(sql)) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve(undefined);
    });
    const { service } = makeService(query);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(Logger.prototype.error).toHaveBeenCalled();
    // Later index statements still ran despite the earlier failure.
    const executed = query.mock.calls.map((call) => call[0] as string).join('\n');
    expect(executed).toMatch(/IDX_pairs_token0_address/);
  });
});
