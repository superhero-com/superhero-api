import { DATABASE_CONFIG } from '@/configs';

type DatabaseLogger = {
  error: (message: string, trace?: string) => unknown;
};

export type DatabaseIssuePoolConfig = {
  max: number;
  min: number;
  connectionTimeoutMillis: number;
};

const defaultExtra = (DATABASE_CONFIG as any)?.extra ?? {};

export const DEFAULT_DATABASE_ISSUE_POOL_CONFIG: DatabaseIssuePoolConfig = {
  max: Number(defaultExtra.max ?? 40),
  min: Number(defaultExtra.min ?? 5),
  connectionTimeoutMillis: Number(
    defaultExtra.connectionTimeoutMillis ?? 10_000,
  ),
};

export function isDatabaseConnectionOrPoolError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const normalized = message.toLowerCase();

  return [
    'timeout exceeded when trying to connect',
    'too many clients already',
    'remaining connection slots are reserved',
    'connection terminated unexpectedly',
    'connection ended unexpectedly',
    'connection refused',
    'econnrefused',
    'etimedout',
    'connection error',
  ].some((fragment) => normalized.includes(fragment));
}

export function getDatabaseIssueKind(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const normalized = message.toLowerCase();

  if (normalized.includes('timeout exceeded when trying to connect')) {
    return 'pool_timeout';
  }
  if (
    normalized.includes('too many clients already') ||
    normalized.includes('remaining connection slots are reserved')
  ) {
    return 'pool_exhausted';
  }
  if (
    normalized.includes('connection refused') ||
    normalized.includes('econnrefused')
  ) {
    return 'connection_refused';
  }
  if (
    normalized.includes('connection terminated unexpectedly') ||
    normalized.includes('connection ended unexpectedly')
  ) {
    return 'connection_terminated';
  }
  if (
    normalized.includes('etimedout') ||
    normalized.includes('connection error')
  ) {
    return 'connectivity_error';
  }

  return 'unknown_db_connectivity_issue';
}

export function logDatabaseIssue(params: {
  logger: DatabaseLogger;
  stage: string;
  error: unknown;
  context: Record<string, unknown>;
  poolConfig?: DatabaseIssuePoolConfig;
}): void {
  const poolConfig = params.poolConfig ?? DEFAULT_DATABASE_ISSUE_POOL_CONFIG;
  const issueKind = getDatabaseIssueKind(params.error);
  const message =
    params.error instanceof Error
      ? params.error.message
      : String(params.error ?? 'unknown error');
  const contextJson = JSON.stringify({
    ...params.context,
    dbPoolMax: poolConfig.max,
    dbPoolMin: poolConfig.min,
    dbConnectTimeoutMs: poolConfig.connectionTimeoutMillis,
    issueKind,
  });

  params.logger.error(
    `Database connectivity/pool issue during ${params.stage}: ${message}. Context: ${contextJson}`,
    params.error instanceof Error ? params.error.stack : undefined,
  );
}

export async function runWithDatabaseIssueLogging<T>(params: {
  logger: DatabaseLogger;
  stage: string;
  context: Record<string, unknown>;
  operation: () => Promise<T>;
  poolConfig?: DatabaseIssuePoolConfig;
}): Promise<T> {
  try {
    return await params.operation();
  } catch (error) {
    if (isDatabaseConnectionOrPoolError(error)) {
      logDatabaseIssue({
        logger: params.logger,
        stage: params.stage,
        error,
        context: params.context,
        poolConfig: params.poolConfig,
      });
    }
    throw error;
  }
}
