import type { JobOptions } from 'bull';
import { ROOM_NOTIFY_QUEUE } from './room-notify.types';

/**
 * Job NAME for room **message** notifications on the shared `worker:room-notify`
 * queue (Task 14, plan §7.1).
 *
 * ## Why a named job on the SAME queue (not a new queue)
 * Task 12 already owns the `worker:room-notify` queue + its **unnamed** `@Process()`
 * consumer for membership pushes (`RoomNotifyJob`). Bull's unnamed processor only
 * picks up the default job name, so message notifications ride the same queue under
 * a distinct name (`'room-message'`) consumed by a separate named `@Process()` in
 * {@link RoomMessageNotifyProcessor}. The two job shapes never collide, and the
 * circuit-breaker (§7.1) measures one shared depth across both producers — exactly
 * the "queue isolation per process, not per notification type" model of plan §9.
 * (The task file's `room-notify.types.ts`/`room-notify.processor.ts` names were
 * taken by Task 12 landing first; these `room-message-notify.*` files are the
 * Task-14 counterparts, kept distinct so neither task edits the other's wiring.)
 */
export const ROOM_MESSAGE_NOTIFY_JOB = 'room-message';

/** Re-export so the producer/consumer reference one canonical queue name. */
export { ROOM_NOTIFY_QUEUE };

/**
 * Payload for a coalesced room-message notification (plan §7.1, requirement §5).
 * Thin by design: the consumer re-checks device(s) + mute + symbol from the DB at
 * dispatch time, so a stale snapshot never travels through the queue. One job per
 * `(recipient, room)` per coalescing flush — NOT one per message.
 */
export interface RoomMessageNotifyJob {
  /** `Token.sale_address` — the room key / NIP-29 group id. */
  sale_address: string;
  /** æternity account address to notify. */
  recipient: string;
  /** Room label (token symbol) captured at flush; consumer may re-resolve. */
  symbol: string;
  /** Number of messages seen for this room within the coalescing window. */
  message_count: number;
  /** Unix-seconds timestamp the coalescing window opened (dedup-key salt). */
  window_started_at: number;
  /** A representative event id from the window (kept for the dedup key / logs). */
  sample_event_id: string;
}

/**
 * Job options for `worker:room-notify` message jobs. Coalesced message pushes are
 * best-effort and low-value once stale; a couple of retries cover a transient
 * device-lookup / Redis blip without spinning, and rows are removed on
 * settle so the queue (and the circuit-breaker depth) doesn't grow unbounded.
 */
export function roomMessageNotifyJobOptions(): JobOptions {
  return {
    attempts: 3,
    backoff: { type: 'fixed', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: true,
  };
}
