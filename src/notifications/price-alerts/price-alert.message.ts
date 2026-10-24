import { createHash } from 'crypto';

export type PriceAlertIntent =
  | {
      action: 'create';
      saleAddress: string;
      direction: 'above' | 'below';
      targetAe: string;
    }
  | { action: 'delete'; alertId: number };

/** Canonical hash of the signed price-alert body (ASCII tokens only). */
export function canonicalPriceAlertHash(intent: PriceAlertIntent): string {
  const canonical =
    intent.action === 'create'
      ? `action=create;sale=${intent.saleAddress};direction=${intent.direction};target=${intent.targetAe}`
      : `action=delete;id=${intent.alertId}`;
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Intent-bound message for creating/deleting a price alert. The first two lines
 * differ from every other notification intent, so a signature captured for
 * another flow cannot be replayed here; the body hash binds token, direction
 * and target (or the alert id).
 *
 * Format (reproduce byte-for-byte on the client):
 *   Superhero Notifications
 *   Price alert for <address>
 *   body: <sha256(canonical body)>
 *   nonce: <nonce>
 */
export function buildPriceAlertMessage(
  address: string,
  nonce: string,
  intent: PriceAlertIntent,
): string {
  return `Superhero Notifications\nPrice alert for ${address}\nbody: ${canonicalPriceAlertHash(
    intent,
  )}\nnonce: ${nonce}`;
}
