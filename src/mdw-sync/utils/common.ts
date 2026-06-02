import { ITransaction } from '@/utils/types';

export function isSelfTransferTx(transaction: ITransaction) {
  if (transaction.tx.type !== 'SpendTx') {
    return false;
  }
  return transaction.tx.recipientId === transaction.tx.senderId;
}

/**
 * Convert a stored transaction `micro_time` to a `Date`.
 *
 * Middleware `micro_time` is microseconds since the epoch (the same convention
 * used by the affiliation analytics queries, which divide by 1e6 before
 * `to_timestamp`). The magnitude is inspected first so legacy millisecond /
 * second values are still handled. Returns null for empty, non-positive or
 * unparseable input.
 */
export function microTimeToDate(value?: string | null): Date | null {
  if (!value) {
    return null;
  }
  try {
    const raw = BigInt(value);
    if (raw <= 0n) {
      return null;
    }
    // Microseconds (>= ~1e15, i.e. 16+ digits): scale down to milliseconds.
    if (raw > 1_000_000_000_000_000n) {
      return new Date(Number(raw / 1000n));
    }
    // Already milliseconds (~1e10 .. 1e15, i.e. 11-15 digits, covering modern
    // 13-digit epoch ms): use as-is. Note: dividing this range would push a
    // real millisecond timestamp (~1.7e12) back to ~1970.
    if (raw > 10_000_000_000n) {
      return new Date(Number(raw));
    }
    // Seconds (<= ~1e10): scale up to milliseconds.
    return new Date(Number(raw) * 1000);
  } catch {
    return null;
  }
}
