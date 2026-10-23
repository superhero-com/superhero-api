/**
 * Emitted after a tip (TIP_PROFILE / TIP_POST SpendTx) indexed from the live
 * stream is committed. Cross-cutting consumers (the notifications module)
 * subscribe so the receiver can be told.
 *
 * Owned by the social-tipping plugin; consumers import the name/type. The
 * plugin never imports the consumers.
 */
export const TIP_RECEIVED_EVENT = 'social-tipping.tip.received';

export interface TipReceivedEventPayload {
  /** Account that sent the tip (notification subject). */
  senderAddress: string;
  /** Account that received the tip (notification recipient). */
  receiverAddress: string;
  /** Tip amount, already formatted in AE. */
  amountAe: string;
  /** Tipped post id for TIP_POST, undefined for profile tips. */
  postId?: string;
  /** Tip tx hash, used as the dedup key. */
  txHash: string;
}
