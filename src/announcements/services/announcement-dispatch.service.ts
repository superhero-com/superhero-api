import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Encoded } from '@aeternity/aepp-sdk';
import {
  NotificationService,
  SendOutcome,
} from '@/notifications/core/notification.service';
import { DeviceService } from '@/notifications/services/device.service';
import { AnnouncementNotification } from '@/notifications/notifications/announcement.notification';
import { chunk } from '@/notifications/common/chunk';
import { Announcement } from '../entities/announcement.entity';
import { AnnouncementService } from './announcement.service';
import announcementsConfig from '../announcements.config';

/**
 * Resolves an announcement's recipients and fans them out through the notification
 * engine. The row's `claim_token` (stamped by `claimNextDue`) is the ownership
 * identifier; every heartbeat and the terminal markCompleted check it via WHERE
 * so a peer replica that took over (after our claim went stale) cannot have its
 * counters silently clobbered by a resuming original.
 */
@Injectable()
export class AnnouncementDispatchService {
  private readonly logger = new Logger(AnnouncementDispatchService.name);

  constructor(
    private readonly announcements: AnnouncementService,
    private readonly deviceService: DeviceService,
    private readonly notifications: NotificationService,
    @Inject(announcementsConfig.KEY)
    private readonly config: ConfigType<typeof announcementsConfig>,
  ) {}

  async run(announcement: Announcement): Promise<void> {
    const token = announcement.claim_token;
    if (!token) {
      // claimNextDue is supposed to stamp a fresh UUID; if it's somehow null
      // we don't have a safe way to mark complete without clobbering a peer.
      this.logger.error(
        `Announcement ${announcement.id} reached dispatch without a claim_token; refusing to run`,
      );
      return;
    }
    const notification = new AnnouncementNotification({
      id: announcement.id,
      title: announcement.title,
      description: announcement.description,
    });

    let addresses: string[];
    try {
      addresses =
        announcement.target_type === 'all'
          ? await this.deviceService.distinctAddressesWithDevice()
          : await this.announcements.addressesFor(announcement.id);
    } catch (error) {
      // A recipient-resolution failure is almost always transient (a DB blip).
      // Re-throw rather than markCompleted with zero counters — completing it
      // here would permanently swallow the announcement on a momentary outage.
      // Throwing hands the row back to the scheduler's crash path, which
      // releaseClaim()s it for retry next tick and escapes a deterministically
      // failing row via the persisted attempt_count cap (markPoisoned).
      this.logger.error(
        `Failed to resolve recipients for announcement ${announcement.id}; releasing for retry`,
        error as Error,
      );
      throw error;
    }

    let delivered = 0;
    let optedOut = 0;
    let noChannel = 0;
    let failed = 0;
    let firstError: string | undefined;

    const batches = chunk(addresses, this.config.fanoutBatch);
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const outcomes = await Promise.all(
        batch.map((address) =>
          this.notifications
            .send({ address: address as Encoded.AccountAddress }, notification)
            .catch<SendOutcome>((err) => ({
              outcome: 'failed',
              channel: 'expo',
              error: err instanceof Error ? err.message : String(err),
            })),
        ),
      );
      for (const result of outcomes) {
        switch (result.outcome) {
          case 'sent':
            delivered += 1;
            break;
          case 'opted-out':
            optedOut += 1;
            break;
          case 'no-channel':
            // Distinct from `failed`: the user simply has no registered
            // channel for this notification type. Surfacing it as a per-
            // recipient delivery failure would page operators for what is
            // actually correct behavior.
            noChannel += 1;
            break;
          case 'failed':
            failed += 1;
            firstError ??= result.error;
            break;
        }
      }

      // Heartbeat the row's claim every few batches so a long-running fan-out
      // (e.g. 'send to all' against 100k device-owning addresses) is not
      // mistaken for a stuck claim by releaseStuck. Skip the last batch —
      // markCompleted runs right after and clears claimed_at anyway.
      if (batchIdx < batches.length - 1 && batchIdx % 5 === 4) {
        try {
          const stillOwned = await this.announcements.heartbeatClaim(
            announcement.id,
            token,
          );
          if (!stillOwned) {
            // The claim_token WHERE clause caught a peer takeover: releaseStuck
            // released our claim and another replica has re-claimed under a
            // different token. Finishing here would race markCompleted writes;
            // abort cleanly so the peer's counters land authoritatively.
            this.logger.warn(
              `Lost claim mid-flight for announcement ${announcement.id}; another replica took over — aborting`,
            );
            return;
          }
        } catch (error) {
          // Best-effort heartbeat. A failure here is non-fatal: worst case
          // releaseStuck eventually reclaims the row, which dispatch.run
          // retries idempotently (per-recipient Redis dedup is the backstop).
          this.logger.warn(
            `Heartbeat failed for announcement ${announcement.id}: ${(error as Error).message}`,
          );
        }
      }
    }

    const completed = await this.announcements.markCompleted(
      announcement.id,
      token,
      {
        recipientCount: addresses.length,
        deliveredCount: delivered,
        optedOutCount: optedOut,
        noChannelCount: noChannel,
        failedCount: failed,
        error: firstError,
      },
    );
    if (!completed) {
      this.logger.warn(
        `Announcement ${announcement.id} markCompleted no-op'd: claim_token mismatch (peer took over after our last heartbeat)`,
      );
      return;
    }
    this.logger.log(
      `Announcement ${announcement.id} completed: ${delivered} delivered, ${optedOut} opted-out, ${noChannel} no-channel, ${failed} failed (of ${addresses.length})`,
    );
  }
}
