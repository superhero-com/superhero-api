import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import 'dotenv/config';

type ValidLoggerType = 'debug' | 'advanced-console' | 'simple-console' | 'file';
type ValidDatabaseType = 'postgres';

const parseNumber = (
  value: string | undefined,
  defaultValue: number,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number => {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  if (options.integer && !Number.isInteger(parsed)) {
    return defaultValue;
  }
  if (options.min !== undefined && parsed < options.min) {
    return defaultValue;
  }
  if (options.max !== undefined && parsed > options.max) {
    return defaultValue;
  }
  return parsed;
};

// Validate logger value
const getValidLogger = (loggerValue: string | undefined): ValidLoggerType => {
  const validLoggers: ValidLoggerType[] = [
    'debug',
    'advanced-console',
    'simple-console',
    'file',
  ];
  return validLoggers.includes(loggerValue as ValidLoggerType)
    ? (loggerValue as ValidLoggerType)
    : 'advanced-console';
};

const getValidDatabaseType = (
  dbTypeValue: string | undefined,
): ValidDatabaseType => {
  const validDatabaseTypes: ValidDatabaseType[] = ['postgres'];
  if (!dbTypeValue) {
    return 'postgres';
  }
  if (validDatabaseTypes.includes(dbTypeValue as ValidDatabaseType)) {
    return dbTypeValue as ValidDatabaseType;
  }
  throw new Error(
    `Invalid DB_TYPE "${dbTypeValue}". Supported values: ${validDatabaseTypes.join(', ')}`,
  );
};

// `synchronize: true` auto-applies destructive DDL (DROP/ALTER) on startup
// based on entity definitions and has caused silent data loss in real-world
// projects. It must never be enabled in production, regardless of env vars.
// We still allow it in non-production environments because the existing
// dev/testnet workflows rely on it; migrations are the long-term fix.
const DB_SYNC_ENABLED =
  process.env.NODE_ENV !== 'production' && process.env.DB_SYNC === 'true';

if (process.env.NODE_ENV === 'production' && process.env.DB_SYNC === 'true') {
  // eslint-disable-next-line no-console
  console.error(
    '[security] DB_SYNC=true was set in production and is being ignored.' +
      ' Use migrations to evolve the schema.',
  );
}

export const DATABASE_CONFIG: TypeOrmModuleOptions = {
  type: getValidDatabaseType(process.env.DB_TYPE),
  host: process.env.DB_HOST,
  port: parseNumber(process.env.DB_PORT, 5432, {
    integer: true,
    min: 1,
    max: 65_535,
  }),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  synchronize: DB_SYNC_ENABLED,
  autoLoadEntities: true,
  logging: process.env.DB_LOGGING === 'true',
  logger: getValidLogger(process.env.DB_LOGGER),
  extra: {
    max: parseNumber(process.env.DB_POOL_MAX, 40, {
      integer: true,
      min: 1,
    }),
    min: parseNumber(process.env.DB_POOL_MIN, 5, {
      integer: true,
      min: 1,
    }),
    idleTimeoutMillis: parseNumber(
      process.env.DB_POOL_IDLE_TIMEOUT_MS,
      30_000,
      {
        integer: true,
        min: 1,
      },
    ),
    connectionTimeoutMillis: parseNumber(
      process.env.DB_POOL_CONNECTION_TIMEOUT_MS,
      10_000,
      {
        integer: true,
        min: 1,
      },
    ),
  },
};
