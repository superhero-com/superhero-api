import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebPushSubscription } from '../entities/web-push-subscription.entity';

export interface WebPushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/**
 * Read/write model for browser Web Push subscriptions. Endpoint is the natural
 * key: a re-subscribe of the same browser upserts (re-points the row to the
 * currently-proven address and bumps `last_seen_at`) rather than duplicating.
 * All reads are scoped by `address`; the controller's session guard proves the
 * caller owns that address first.
 *
 * Deliberately NOT wired into the `notif:has-devices` registry: that set gates
 * only the Expo-only incoming-transfer hot path and the (Expo) announcement
 * fan-out, so adding web-only addresses there would just cause no-op Expo
 * dispatches. The web-push notification types (invitation-claimed, post-comment)
 * are dispatched ungated, so this channel reaches web-only users without it.
 */
@Injectable()
export class WebPushSubscriptionService {
  private readonly logger = new Logger(WebPushSubscriptionService.name);

  constructor(
    @InjectRepository(WebPushSubscription)
    private readonly repo: Repository<WebPushSubscription>,
  ) {}

  /**
   * Register or refresh a subscription for `address`. Upsert on the unique
   * `endpoint` so the same browser re-subscribing (or switching accounts)
   * re-points the row instead of creating duplicates.
   *
   * `endpoint`/`p256dh`/`auth` are ALL supplied by the caller in this same
   * request, with nothing cryptographically binding them to a specific
   * address — unlike the device-link flow, there is no signed message to
   * verify here. An earlier version of this method tried to gate re-pointing
   * on "does the caller's p256dh/auth match what's on file", rejecting the
   * request with a ConflictException when they didn't. That doesn't actually
   * protect anything: an attacker who learns a victim's endpoint (a leaked
   * log line, a shared device, a race with the victim's own first-ever
   * registration) can register it FIRST with forged keys under their own
   * address — no existing row yet, so nothing to compare against — after
   * which the real owner's later, genuine re-subscribe permanently fails the
   * key-match check and can never reclaim their own endpoint. That is worse
   * than the takeover it tried to prevent: the original behavior (unconditional
   * re-pointing) was at least self-healing, since the real owner could always
   * re-subscribe again to take the row back. Re-pointing across addresses is
   * therefore allowed unconditionally (same as before); only logged so an
   * anomalous pattern is visible to ops rather than silent.
   */
  async upsert(address: string, sub: WebPushSubscriptionInput): Promise<void> {
    const existing = await this.repo.findOne({
      where: { endpoint: sub.endpoint },
    });
    if (existing && existing.address !== address) {
      this.logger.warn(
        `Web-push endpoint re-pointed from ${existing.address} to ${address}`,
      );
    }

    await this.repo.upsert(
      {
        address,
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
        user_agent: sub.userAgent ?? null,
        last_seen_at: () => 'CURRENT_TIMESTAMP(6)',
      },
      ['endpoint'],
    );
  }

  /** Remove a subscription (scoped to the owning address). */
  async remove(address: string, endpoint: string): Promise<void> {
    await this.repo.delete({ address, endpoint });
  }

  /** All subscriptions currently registered for an address. */
  async getActiveForAddress(address: string): Promise<WebPushSubscription[]> {
    return this.repo.find({ where: { address } });
  }

  /**
   * Delete a dead subscription by endpoint (called when a send returns 404/410).
   * Not scoped to an address: a gone endpoint should be cleared wherever it
   * lives. The `notif:has-devices` set is reconciled by the hourly rebuild, so
   * we don't eagerly remove the address here (a stale `true` only costs a later
   * no-op dispatch; a stale `false` would miss notifications).
   */
  async prune(endpoint: string): Promise<void> {
    await this.repo.delete({ endpoint });
  }
}
