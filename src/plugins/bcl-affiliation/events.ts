/**
 * Emitted after a `redeem_invitation_code` transaction is persisted to the
 * `invitations` table — i.e. an invite that user A created has just been
 * claimed by user B. Cross-cutting consumers (e.g. the notifications module)
 * subscribe to this so the inviter can be told.
 *
 * Owned by the bcl-affiliation plugin; consumers import the name/type.
 * The plugin never imports the consumers.
 */
export const INVITATION_CLAIMED_EVENT = 'bcl-affiliation.invitation.claimed';

export interface InvitationClaimedEventPayload {
  invitationId: string;
  /** Account that originally created the invite (notification recipient). */
  inviterAddress: string;
  /** Account that just redeemed the invite (notification subject). */
  claimerAddress: string;
  /** Invitation amount, formatted in AE (already converted from aettos). */
  amountAe: string;
  /** The redeem tx hash, used as the per-(notification, recipient) dedup key. */
  txHash: string;
}
