import { EntityManager } from 'typeorm';

// Serialize rank refreshes across replicas before they lock token rows.
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
