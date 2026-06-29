import { Injectable } from '@nestjs/common';

/**
 * In-memory registry of groups the relay reported as missing (`"Group not found"`)
 * and are currently being re-created. Two jobs:
 *
 *  1. **Debounce re-creates** — only the FIRST `tgr.group.missing` for a sale
 *     enqueues a `9007` re-create; the thousands of in-flight member adds that hit
 *     the same missing group are coalesced ({@link RoomBackfillService.onGroupMissing}).
 *  2. **Stop adding members to a missing group** — membership-sync skips enqueuing
 *     `9000` adds for a suppressed sale until the group is confirmed re-created
 *     (`MembershipSyncService.maybeEnqueueAdd`), so we don't pile adds onto a group
 *     that doesn't exist.
 *
 * Cleared when the re-create's `9007` ok-ACK lands (the group is back). Entries also
 * auto-expire after a TTL so a group whose re-create never confirms is retried on
 * the next member-add failure rather than being suppressed forever. Single-process,
 * so plain in-memory is sufficient (it self-heals on restart — the next member-add
 * failure re-marks it).
 */
@Injectable()
export class GroupMissingTracker {
  /** sale_address → expiry epoch ms. */
  private readonly missing = new Map<string, number>();

  /** Default suppression window — generous enough for a throttled re-create to land. */
  static readonly DEFAULT_TTL_MS = 10 * 60 * 1000;

  /** Mark a group missing (re-create in flight). Idempotent; refreshes the TTL. */
  markMissing(
    saleAddress: string,
    ttlMs = GroupMissingTracker.DEFAULT_TTL_MS,
  ): void {
    this.missing.set(saleAddress, Date.now() + Math.max(1, ttlMs));
  }

  /** True iff the group is currently flagged missing (and not expired). */
  isMissing(saleAddress: string): boolean {
    const expiry = this.missing.get(saleAddress);
    if (expiry === undefined) {
      return false;
    }
    if (expiry <= Date.now()) {
      this.missing.delete(saleAddress);
      return false;
    }
    return true;
  }

  /** Clear the flag — the group was confirmed re-created (resume member adds). */
  clear(saleAddress: string): void {
    this.missing.delete(saleAddress);
  }

  /** Count of currently-suppressed groups (observability / tests). */
  get size(): number {
    return this.missing.size;
  }
}
