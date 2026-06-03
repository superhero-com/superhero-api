import { Tx } from './entities/tx.entity';

/**
 * Emitted by the live indexer for every transaction observed on the live MDW
 * stream, BEFORE the plugin relevance filter. Cross-cutting consumers (e.g. the
 * notification module) subscribe to this to react to transactions the indexer
 * intentionally does not persist (such as plain transfers).
 *
 * Owned by mdw-sync; consumers import the name/type. mdw-sync never imports them.
 */
export const LIVE_TX_EVENT = 'chain.tx.live';

/**
 * `hash` is required — downstream consumers (notification dedup) collapse on
 * empty-string hashes. The live indexer always populates it; the optional
 * type was permissive in a way the consumers can't be.
 */
export type LiveTxEventPayload = Partial<Tx> & { hash: string };
