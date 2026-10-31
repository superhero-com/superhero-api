import { Notifiable } from '../core/notifiable.interface';
import {
  AppNotification,
  DatabaseNotificationContent,
  ExpoMessageContent,
  NotificationChannelName,
  NotificationMeta,
} from '../core/notification.interface';

export interface TokenPriceAlertParams {
  alertId: number;
  saleAddress: string;
  symbol: string;
  direction: 'above' | 'below';
  /** Target and current price, already formatted in AE. */
  targetAe: string;
  priceAe: string;
}

/**
 * "<SYMBOL> is above/below X AE" — sent once when a user's price alert fires.
 */
export class TokenPriceAlertNotification implements AppNotification {
  static readonly META: NotificationMeta = {
    type: 'token-price-alert',
    title: 'Price alerts',
    description: 'Notifies you when a token reaches a price you set.',
  };

  readonly type = TokenPriceAlertNotification.META.type;
  readonly title = TokenPriceAlertNotification.META.title;
  readonly description = TokenPriceAlertNotification.META.description;

  constructor(private readonly params: TokenPriceAlertParams) {}

  via(): NotificationChannelName[] {
    return ['expo', 'database', 'web-push'];
  }

  dedupKey(notifiable: Notifiable): string {
    // Alerts are one-shot, so the alert id is unique per firing.
    return `price-alert:${this.params.alertId}:${notifiable.address}`;
  }

  toExpo(): ExpoMessageContent {
    const { symbol, direction, targetAe, priceAe } = this.params;
    return {
      title: `${symbol} price alert`,
      body: `${symbol} is ${direction} ${targetAe} AE (now ${priceAe} AE)`,
      data: {
        type: this.type,
        alertId: this.params.alertId,
        saleAddress: this.params.saleAddress,
        symbol,
        direction,
        targetAe,
        priceAe,
      },
    };
  }

  toDatabase(): DatabaseNotificationContent {
    return this.toExpo();
  }
}
