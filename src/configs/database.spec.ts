describe('APP_DATABASE_CONFIG statement timeout', () => {
  const ORIGINAL = process.env.DB_STATEMENT_TIMEOUT_MS;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.DB_STATEMENT_TIMEOUT_MS;
    } else {
      process.env.DB_STATEMENT_TIMEOUT_MS = ORIGINAL;
    }
    jest.resetModules();
  });

  // The config is read once at module load, so each value needs a fresh module.
  function loadWith(value: string | undefined): typeof import('./database') {
    jest.resetModules();
    if (value === undefined) {
      delete process.env.DB_STATEMENT_TIMEOUT_MS;
    } else {
      process.env.DB_STATEMENT_TIMEOUT_MS = value;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./database');
  }

  it.each([undefined, '', '0', '-1', '1.5', 'abc'])(
    'leaves the timeout off for %p',
    (value) => {
      const { APP_DATABASE_CONFIG } = loadWith(value);

      expect(APP_DATABASE_CONFIG.extra).not.toHaveProperty('statement_timeout');
    },
  );

  it('sets the timeout on the app pool but not on the migration config', () => {
    const { APP_DATABASE_CONFIG, DATABASE_CONFIG } = loadWith('120000');

    expect(APP_DATABASE_CONFIG.extra).toMatchObject({
      statement_timeout: 120_000,
      max: DATABASE_CONFIG.extra.max,
    });
    expect(DATABASE_CONFIG.extra).not.toHaveProperty('statement_timeout');
  });
});
