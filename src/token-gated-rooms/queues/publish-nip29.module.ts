import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import tgrConfig from '../config/tgr.config';
import { RELAY_WRITER } from '../nostr/relay-writer.contract';
import { RelayWriterService } from '../nostr/relay-writer.service';
import {
  cappedBackoffStrategy,
  TGR_CAPPED_BACKOFF,
} from './publish-nip29.job-options';
import {
  PublishNip29Processor,
  PUBLISH_NIP29_QUEUE,
} from './publish-nip29.processor';

/**
 * Bull queue rate ceiling, read at module load (Bull needs the limiter at
 * registration time). Caps publishes to `TG_PUBLISH_RATE_PER_SEC`/sec across the
 * worker (the in-process `TokenBucket` is the second line of defence). The
 * limiter only PACES — a throttled job waits for the next window, never dropped.
 */
function publishLimiter(): { max: number; duration: number } {
  const max = Number(process.env.TG_PUBLISH_RATE_PER_SEC);
  return {
    max: Number.isFinite(max) && max > 0 ? max : 100,
    duration: 1000,
  };
}

/**
 * The `groups_relay` write path (Task 07). Bundles the long-lived
 * `RelayWriterService`, the `worker:publish-nip29` consumer, the queue
 * registration (token-bucket limiter + capped-exponential backoff strategy), and
 * exports the writer so Task 11 can call `fetchGroupMembers`.
 *
 * Always imported by `TokenGatedRoomsModule` (worker mode removed — see
 * `deworker-plan.md`); the writer stays dormant and the queue idle until a relay
 * is configured (`isRelayConfigured`).
 */
@Module({
  imports: [
    ConfigModule.forFeature(tgrConfig),
    BullModule.registerQueue({
      name: PUBLISH_NIP29_QUEUE,
      limiter: publishLimiter(),
      settings: {
        backoffStrategies: {
          [TGR_CAPPED_BACKOFF]: (attemptsMade: number) =>
            cappedBackoffStrategy(attemptsMade),
        },
      },
    }),
  ],
  providers: [
    RelayWriterService,
    // Expose the writer under the nostr-free DI token so consumers (the
    // processor, Task 11) inject the interface, not the concrete class.
    { provide: RELAY_WRITER, useExisting: RelayWriterService },
    PublishNip29Processor,
  ],
  exports: [RelayWriterService, RELAY_WRITER],
})
export class PublishNip29Module {}
