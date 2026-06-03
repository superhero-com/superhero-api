import { Notifiable } from './notifiable.interface';
import {
  AppNotification,
  NotificationChannelName,
} from './notification.interface';

/**
 * A delivery transport. Responsible for resolving routing, applying idempotency,
 * and handing heavy network I/O to a queue. `ExpoChannel` is the only v1 impl.
 */
export interface NotificationChannel {
  readonly name: NotificationChannelName;
  send(notifiable: Notifiable, notification: AppNotification): Promise<void>;
}
