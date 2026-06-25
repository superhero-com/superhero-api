import { Logger } from '@nestjs/common';
import { DexSchemaBootstrapService } from './dex-schema-bootstrap.service';

describe('DexSchemaBootstrapService', () => {
  const makeService = (query: jest.Mock) => {
    const dataSource = { query };
    return new DexSchemaBootstrapService(dataSource as any);
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs every bootstrap statement once on init', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const service = makeService(query);

    await service.onModuleInit();

    expect(query).toHaveBeenCalledTimes(
      DexSchemaBootstrapService.STATEMENTS.length,
    );
    for (const statement of DexSchemaBootstrapService.STATEMENTS) {
      expect(query).toHaveBeenCalledWith(statement);
    }
  });

  it('ensures the listed column and pair-history index idempotently', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const service = makeService(query);

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

  it('does not throw and continues when a statement fails', async () => {
    const query = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const service = makeService(query);

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    // The failing first statement must not prevent the remaining ones.
    expect(query).toHaveBeenCalledTimes(
      DexSchemaBootstrapService.STATEMENTS.length,
    );
    expect(Logger.prototype.error).toHaveBeenCalled();
  });
});
