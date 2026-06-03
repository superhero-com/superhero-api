import { Encoded } from '@aeternity/aepp-sdk';

/**
 * The recipient of a notification. Kept as a thin value object: routing (address ->
 * device tokens) is the channel's responsibility, so notifications stay decoupled
 * from persistence and easy to test.
 */
export interface Notifiable {
  address: Encoded.AccountAddress; // ak_...
}
