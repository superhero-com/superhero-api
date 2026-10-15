import { EntityManager } from 'typeorm';

// Shared by bulk rank updates and legacy incomplete-token cleanup. Acquire
// before either job locks token rows, across all API replicas. A busy job can
// defer to its next scheduled run rather than queue behind another sweep.
export const TOKEN_MAINTENANCE_LOCK_KEY = 4019283750;

export async function tryLockTokenMaintenance(
  manager: EntityManager,
): Promise<boolean> {
  const [result] = await manager.query(
    'SELECT pg_try_advisory_xact_lock($1) AS locked',
    [TOKEN_MAINTENANCE_LOCK_KEY],
  );
  return result?.locked === true;
}
