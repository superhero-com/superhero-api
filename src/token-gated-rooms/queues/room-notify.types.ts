import type { JobOptions } from 'bull';
import { prefixQueue, TGR_QUEUE_NAMES } from '../config/queue-prefix';
import type { RoomMembershipChange } from '../notifications/room-membership.notification';

/**
 * Resolved queue name (`worker:room-notify`) — the membership-notification fan-out
 * queue. Consumed by the worker process (Task 12 / plan §7). The listener
 * (`RoomEventListener`) is the only producer in this task.
 */
export const ROOM_NOTIFY_QUEUE = prefixQueue(
  TGR_QUEUE_NAMES.ROOM_NOTIFY,
  'worker',
);

/**
 * Job payload for `worker:room-notify`. Thin by design (mirrors the THIN in-process
 * events): the processor re-resolves the member's device(s) + room symbol + mute
 * state from the DB, so a stale snapshot never travels through the queue.
 */
export interface RoomNotifyJob {
  /** `Token.sale_address` — the room key. */
  saleAddress: string;
  /** æternity account address to notify. */
  memberAddress: string;
  /** Whether the holder was added to or removed from the room. */
  change: RoomMembershipChange;
  /**
   * `room_membership_event.id` for this transition (access-ledger plan). The
   * processor stamps `notified_at` on dispatch → durable dedup (never re-push the
   * same access transition on a Bull retry / after a restart).
   */
  accessEventId?: string;
  /** True iff the member's first-ever access grant (drives "Welcome" copy). */
  isFirstGrant?: boolean;
}

/**
 * Job options for `worker:room-notify`. Membership pushes are low-frequency and
 * best-effort; a couple of retries cover a transient device-lookup / Redis blip
 * without spinning. `removeOnComplete` keeps the queue from growing unbounded.
 */
export function roomNotifyJobOptions(): JobOptions {
  return {
    attempts: 3,
    backoff: { type: 'fixed', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: true,
  };
}
