import type { Nip29Template } from '../nostr/nip29';

/**
 * Job payload for the `worker:publish-nip29` Bull queue (Task 07 §4).
 *
 * Callers (Tasks 08/09/10) build `template` with the `nip29.ts` builders and
 * enqueue; this task's processor consumes, signs, publishes, waits for the relay
 * ACK, and emits `tgr.publish.ack`. The processor reads `meta.saleAddress` /
 * `template.kind` / the `["p", …]` tag for the ack payload.
 */
export interface PublishNip29Job {
  /** A finalize-ready NIP-29 event template (`{ kind, tags, content? }`). */
  template: Nip29Template;
  /** The group id (= `Token.sale_address`); also present as `template.tags[0]`. */
  groupId: string;
  /** Optional correlation metadata for the ack seam / observability. */
  meta?: {
    /** `Token.sale_address` for the ack payload (falls back to `groupId`). */
    saleAddress?: string;
    /** Human reason this publish was enqueued (logging only). */
    reason?: string;
  };
}
