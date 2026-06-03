import { Notifiable } from '../core/notifiable.interface';
import {
  AppNotification,
  ExpoMessageContent,
  NotificationChannelName,
  NotificationMeta,
} from '../core/notification.interface';
import { shortenAddress } from '../notifications.constants';

export interface InvitationClaimedParams {
  /** Notification recipient — the user who originally created the invitation. */
  inviter: string;
  /** The user who just redeemed the invite. */
  claimer: string;
  /** Invitation amount, already formatted in AE. */
  amountAe: string;
  /** Redeem tx hash, used as the dedup key. */
  txHash: string;
  /** Optional human label for the claimer (chain name). */
  claimerLabel?: string;
}

/**
 * "<X> just claimed your invitation for Y AE" — triggered when a redeem_invitation_code
 * transaction is observed for an invite the recipient originally registered.
 */
export class InvitationClaimedNotification implements AppNotification {
  static readonly META: NotificationMeta = {
    type: 'invitation-claimed',
    title: 'Invitation claims',
    description: 'Notifies you when someone redeems an invitation you created.',
  };

  readonly type = InvitationClaimedNotification.META.type;
  readonly title = InvitationClaimedNotification.META.title;
  readonly description = InvitationClaimedNotification.META.description;

  constructor(private readonly params: InvitationClaimedParams) {}

  via(): NotificationChannelName[] {
    return ['expo'];
  }

  dedupKey(notifiable: Notifiable): string {
    // One notification per (claim tx, inviter) — guards retries / reorg replays.
    return `${this.params.txHash}:${notifiable.address}`;
  }

  toExpo(): ExpoMessageContent {
    const who = this.params.claimerLabel || shortenAddress(this.params.claimer);
    return {
      title: 'Invitation claimed',
      body: `${who} just claimed your invitation for ${this.params.amountAe} AE`,
      data: {
        type: this.type,
        txHash: this.params.txHash,
        claimer: this.params.claimer,
        amountAe: this.params.amountAe,
      },
    };
  }
}
