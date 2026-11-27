export const PRIVATE_CLEANUP_BATCH_LIMIT = 128;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface PrivateCleanupVerificationRequest {
  operationId: string;
  verificationId: string;
}
export interface PrivateCleanupCandidate {
  id: string;
  barrier: string;
  inventory: string;
  identity: string;
}
function rows(value: unknown, fields: string[]) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > PRIVATE_CLEANUP_BATCH_LIMIT ||
    value.some(
      (row) =>
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Object.keys(row).length !== fields.length ||
        fields.some((field) => typeof row[field] !== 'string') ||
        Object.keys(row).some((field) => !fields.includes(field)),
    )
  )
    throw new Error('Invalid private cleanup batch');
  return value as Record<string, string>[];
}
/** Copy caller-owned input before asynchronous work; IDs and proofs cannot be reused within a batch. */
export function privateCleanupVerifications(
  value: unknown,
): PrivateCleanupVerificationRequest[] {
  const items = rows(value, ['operationId', 'verificationId']);
  if (
    items.some(
      (row) => !uuid.test(row.operationId) || !uuid.test(row.verificationId),
    ) ||
    new Set(items.map((row) => row.operationId)).size !== items.length ||
    new Set(items.map((row) => row.verificationId)).size !== items.length
  )
    throw new Error('Invalid private cleanup verification batch');
  return items.map((row) => ({
    operationId: row.operationId,
    verificationId: row.verificationId,
  }));
}
export function privateCleanupCandidates(
  value: unknown,
): PrivateCleanupCandidate[] {
  const items = rows(value, ['id', 'barrier', 'inventory', 'identity']);
  if (
    items.some(
      (row) =>
        !uuid.test(row.id) ||
        !uuid.test(row.barrier) ||
        !uuid.test(row.inventory) ||
        !/^[a-f0-9]{64}$/.test(row.identity),
    ) ||
    new Set(items.map((row) => row.id)).size !== items.length
  )
    throw new Error('Invalid private cleanup candidate batch');
  return items.map((row) => ({
    id: row.id,
    barrier: row.barrier,
    inventory: row.inventory,
    identity: row.identity,
  }));
}
