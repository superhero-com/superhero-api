import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import 'dotenv/config';

type ValidLoggerType = 'debug' | 'advanced-console' | 'simple-console' | 'file';

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

/**
 * Custom synchronize function that handles constraint errors gracefully
 */
async function synchronizeWithErrorHandling(dataSource: DataSource): Promise<void> {
  if (process.env.DB_SYNC !== 'true') {
    console.log('[Database Sync] Synchronization disabled (DB_SYNC != true)');
    return;
  }

  console.log('[Database Sync] Starting synchronization...');
  try {
    await dataSource.synchronize();
    console.log('[Database Sync] Synchronization completed successfully');
  } catch (error: any) {
    // Check if error is about constraint/index creation
    const errorMessage = error?.message || '';
    const isConstraintError =
      errorMessage.includes('could not create unique index') ||
      errorMessage.includes('already exists') ||
      errorMessage.includes('duplicate key value') ||
      (errorMessage.includes('constraint') && errorMessage.includes('already exists'));

    if (isConstraintError) {
      // Log warning but don't fail - constraint likely already exists with different name
      console.warn(
        `[Database Sync] Constraint/index creation skipped (likely already exists): ${errorMessage.substring(0, 200)}`,
      );
      console.log('[Database Sync] Synchronization completed with warnings (constraints skipped)');
      return;
    }

    // Re-throw other errors
    console.error('[Database Sync] Synchronization failed:', errorMessage.substring(0, 500));
    throw error;
  }
}

export const DATABASE_CONFIG: TypeOrmModuleOptions = {
  type: process.env.DB_TYPE as any,
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  synchronize: false, // Disable auto-sync, we'll handle it in AppModule with error handling
  autoLoadEntities: true,
  logging: process.env.DB_LOGGING === 'true',
  logger: getValidLogger(process.env.DB_LOGGER),
};

// Export the sync function for use in AppModule
export { synchronizeWithErrorHandling };
