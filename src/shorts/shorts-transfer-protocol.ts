import { createHash, createHmac } from 'node:crypto';

export type TransferPurpose = 'original' | 'assets' | 'inputs';
export function pinPackageCid(
  record: { cid: string; derivatives: { cid: string; assetsCid: string } },
  purpose: TransferPurpose,
) {
  if (purpose === 'original') return record.cid;
  return purpose === 'assets'
    ? record.derivatives.assetsCid
    : record.derivatives.cid;
}

export type TransferGrant =
  | { mode: 'add' }
  | {
      mode: 'expiring';
      operation: string;
      epoch: string;
      peerId: string;
      expires: number;
    };
export interface StoragePinReceipt {
  version: 1;
  status: 'pinned';
  cid: string;
  operation: string;
  epoch: string;
  expires: number;
}

// The request binds the release, generation, source hashes, expected CIDs,
// permitted write, time limit and fresh challenge. Sign the exact transmitted bytes.
export function pinTransferProof(
  key: string,
  request: string | Buffer,
  cid: string,
  receipt: StoragePinReceipt | null | 'rejected',
) {
  const requestHash = createHash('sha256').update(request).digest('hex');
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(
      JSON.stringify(['shorts-pin-transfer-v1', requestHash, cid, receipt]),
    )
    .digest('hex');
}

/** Separate domain for read-only inspections. Bind the verdict and every evidence field. */
export function inspectionProof(
  key: string,
  request: string | Buffer,
  evidence: unknown,
) {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(
      JSON.stringify([
        'shorts-original-inspection-v1',
        createHash('sha256').update(request).digest('hex'),
        evidence,
      ]),
    )
    .digest('hex');
}

export interface RestagingPlan {
  hashes: string[];
  captions?: string;
}

export interface RestagingGrant {
  fence: string;
  leaseHash: string;
  manifestSha256: string;
  targetHash: string;
  targets: { keyId: string; sha256: string }[];
}

export function restagingTargetHash(
  refs: { key: string; keyId: string; bytes: number; sha256: string }[],
) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        refs.map((ref) => [ref.key, ref.keyId, ref.bytes, ref.sha256]),
      ),
    )
    .digest('hex');
}

export function restagingProof(
  key: string,
  request: string | Buffer,
  phase: 'plan' | 'write',
  result: unknown,
) {
  const digest = createHash('sha256').update(request).digest('hex');
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(JSON.stringify(['shorts-restaging-v1', phase, digest, result]))
    .digest('hex');
}

export interface PreviewReceipt {
  node: string;
  ticket: string;
  expires: number;
  bytes: number;
  sha256: string;
}
export function previewProof(
  key: string,
  request: string | Buffer,
  receipt: PreviewReceipt,
) {
  const digest = createHash('sha256').update(request).digest('hex');
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(JSON.stringify(['shorts-review-preview-v1', digest, receipt]))
    .digest('hex');
}

export function validObjectVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== 'null' &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= 1024
  );
}
export function versionReadbackProof(
  key: string,
  request: string | Buffer,
  receipt: unknown,
) {
  const digest = createHash('sha256').update(request).digest('hex');
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(
      JSON.stringify(['shorts-private-version-readback-v1', digest, receipt]),
    )
    .digest('hex');
}
