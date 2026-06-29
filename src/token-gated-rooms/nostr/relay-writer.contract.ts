import type { Nip29Template } from './nip29';

/**
 * Nostr-free contract for the relay write client (Task 07). Kept separate from
 * `relay-writer.service.ts` so consumers (the `publish-nip29` processor, Task 11
 * reconciliation) can depend on the INTERFACE + DI token without importing
 * `nostr-tools` (which pulls in ESM `@noble/*` crypto that ts-jest cannot
 * transform in plain unit tests). The concrete service implements this and is
 * provided under {@link RELAY_WRITER}.
 */

/** DI token for the relay writer (inject the interface, not the concrete class). */
export const RELAY_WRITER = Symbol('TGR_RELAY_WRITER');

/**
 * Outcome of a single low-level publish (§1.4). Flat shape (not a discriminated
 * union) because this repo runs `strictNullChecks:false`, which disables union
 * narrowing — callers read `ok` then `reason`/`timedOut`.
 */
export interface PublishResult {
  /** ACK ok (relay accepted). */
  ok: boolean;
  /** Signed event id. */
  id: string;
  /** Relay reject reason (only meaningful when `ok` is false). */
  reason?: string;
  /** True when no ACK arrived within `publishAckTimeoutMs`. */
  timedOut?: boolean;
}

/** The relay-admin write client surface (§1). */
export interface RelayWriter {
  /** Bot/relay-admin public key (hex). */
  readonly pubkey: string;
  /** Whether the relay socket is connected + AUTHed (gates the queue). */
  isHealthy(): boolean;
  /** Finalize+sign+publish and wait for the relay ACK; never throws on reject. */
  publish(template: Nip29Template): Promise<PublishResult>;
  /** One-shot `39002` read of a group's current members (§1.5). */
  fetchGroupMembers(groupId: string): Promise<Set<string>>;
}
