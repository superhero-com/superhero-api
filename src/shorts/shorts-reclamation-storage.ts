export interface ReclamationStorage {
  peerId: string;
  nodeEpoch: string;
  serverTimeUnixMs: number;
  clockGuardVersion: 1;
  clockMaxDriftMs: 5000;
}

/** Older or non-exclusive storage nodes cannot authorize physical cleanup. */
export function reclamationStorage(
  value: any,
  now = Date.now(),
): ReclamationStorage {
  if (
    value?.version !== 1 ||
    value.epochVersion !== 1 ||
    value.unpinMaxLifetimeMs !== 30000 ||
    value.unpinTimeoutMs !== 10000 ||
    value.addVersion !== 1 ||
    value.legacyWritesEnabled !== false ||
    value.writing !== false ||
    value.uncertain !== false ||
    value.clockGuardVersion !== 1 ||
    value.clockMaxDriftMs !== 5000 ||
    typeof value.peerId !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,120}$/.test(value.peerId) ||
    typeof value.nodeEpoch !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.nodeEpoch) ||
    !Number.isSafeInteger(value.serverTimeUnixMs) ||
    Math.abs(value.serverTimeUnixMs - now) > 5000
  )
    throw new Error('Exclusive, healthy, clock-guarded storage is required');
  return {
    peerId: value.peerId,
    nodeEpoch: value.nodeEpoch,
    serverTimeUnixMs: value.serverTimeUnixMs,
    clockGuardVersion: 1,
    clockMaxDriftMs: 5000,
  };
}
