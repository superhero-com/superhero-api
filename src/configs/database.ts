import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import 'dotenv/config';

type ValidLoggerType = 'debug' | 'advanced-console' | 'simple-console' | 'file';

const parseNumber = (
  value: string | undefined,
  defaultValue: number,
): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
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

export const DATABASE_CONFIG: TypeOrmModuleOptions = {
  type: process.env.DB_TYPE as any,
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  synchronize: process.env.DB_SYNC === 'true',
  autoLoadEntities: true,
  logging: process.env.DB_LOGGING === 'true',
  logger: getValidLogger(process.env.DB_LOGGER),
  extra: {
    max: parseNumber(process.env.DB_POOL_MAX, 40),
    min: parseNumber(process.env.DB_POOL_MIN, 5),
    idleTimeoutMillis: parseNumber(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30_000),
    connectionTimeoutMillis: parseNumber(
      process.env.DB_POOL_CONNECTION_TIMEOUT_MS,
      10_000,
    ),
  },
};
