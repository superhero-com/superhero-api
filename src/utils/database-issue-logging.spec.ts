import {
  getDatabaseIssueKind,
  isDatabaseConnectionOrPoolError,
  runWithDatabaseIssueLogging,
} from './database-issue-logging';

describe('database issue logging helpers', () => {
  it('detects connection and pool errors', () => {
    expect(
      isDatabaseConnectionOrPoolError(
        new Error('timeout exceeded when trying to connect'),
      ),
    ).toBe(true);
    expect(
      isDatabaseConnectionOrPoolError(new Error('too many clients already')),
    ).toBe(true);
    expect(
      isDatabaseConnectionOrPoolError(new Error('duplicate key value')),
    ).toBe(false);
  });

  it('classifies common database connectivity issue kinds', () => {
    expect(
      getDatabaseIssueKind(new Error('timeout exceeded when trying to connect')),
    ).toBe('pool_timeout');
    expect(getDatabaseIssueKind(new Error('too many clients already'))).toBe(
      'pool_exhausted',
    );
    expect(getDatabaseIssueKind(new Error('connect ECONNREFUSED'))).toBe(
      'connection_refused',
    );
  });

  it('logs structured context for retryable database connectivity errors', async () => {
    const logger = {
      error: jest.fn(),
    };

    await expect(
      runWithDatabaseIssueLogging({
        logger,
        stage: 'token holders upsert',
        context: {
          saleAddress: 'ct_sale',
          holderCount: 25,
        },
        operation: async () => {
          throw new Error('timeout exceeded when trying to connect');
        },
      }),
    ).rejects.toThrow('timeout exceeded when trying to connect');

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Database connectivity/pool issue during token holders upsert: timeout exceeded when trying to connect.',
      ),
      expect.any(String),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('"issueKind":"pool_timeout"'),
      expect.any(String),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('"saleAddress":"ct_sale"'),
      expect.any(String),
    );
  });
});
