import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import {
  SHORTS_PUBLISHER_CONFIG,
  ShortsPublisherConfig,
} from './shorts-publisher.config';
import {
  ShortsPublicationBoundaryService,
  SignedPublicationClaim,
} from './shorts-publication-boundary.service';
import { ShortsPublisherNodeService } from './shorts-publisher-node.service';
import {
  PublisherAttempt,
  SHORTS_PUBLISHER_ATTEMPT_MS,
} from './shorts-publisher-attempt';

@Injectable()
export class ShortsPublisherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ShortsPublisherService.name);
  private stopped = false;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly shutdown = new AbortController();
  constructor(
    @Inject(SHORTS_PUBLISHER_CONFIG)
    private readonly config: ShortsPublisherConfig,
    private readonly boundary: ShortsPublicationBoundaryService,
    private readonly node: ShortsPublisherNodeService,
    @Optional()
    @Inject(SHORTS_PUBLISHER_ATTEMPT_MS)
    private readonly attemptMs = 120000,
  ) {}
  async onApplicationBootstrap() {
    await this.boundary.verify(this.config, 'publisher');
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollMs);
    void this.tick();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    this.shutdown.abort();
    await this.pending;
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.run()
      .catch(() => {
        // Never log node error objects: they may embed signed payloads or connection details.
        this.logger.warn(
          'Publication deferred; its durable request will be reconciled.',
        );
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async run() {
    const attempt = new PublisherAttempt(this.shutdown.signal, this.attemptMs);
    try {
      await attempt.run(() => this.process(attempt));
    } finally {
      attempt.close();
    }
  }
  private async process(attempt: PublisherAttempt) {
    let claim: SignedPublicationClaim | undefined;
    let lost = false,
      settled = false,
      renewing: Promise<void> | undefined;
    let renewal: NodeJS.Timeout | undefined;
    const live = () => {
      attempt.check();
      if (lost || this.stopped)
        throw new Error('Publication lease or process stopped');
    };
    try {
      live();
      const startedAt = performance.now();
      claim = await this.boundary.claim(this.config);
      if (!claim) return;
      attempt.lease(startedAt, this.config.policy.leaseMs);
      renewal = setInterval(
        () => {
          if (renewing || attempt.signal.aborted) return;
          const startedAt = performance.now();
          renewing = this.boundary
            .renew(this.config, claim)
            .then(() => attempt.lease(startedAt, this.config.policy.leaseMs))
            .catch(() => {
              lost = true;
              attempt.abort();
            })
            .finally(() => {
              renewing = undefined;
            });
        },
        Math.max(250, Math.floor(this.config.policy.leaseMs / 3)),
      );
      renewal.unref();
      live();
      await this.node.verify();
      live();
      if (claim.status === 'claimed') {
        const existing = await this.node.existing(claim.intent);
        live();
        if (existing) {
          await this.boundary.reconcile(this.config, claim, existing);
          settled = true;
          return;
        }
        const prepared = await this.node.prepare(claim.intent);
        live();
        claim = await this.boundary.persistSigned(
          this.config,
          claim,
          prepared.rawTransaction,
          prepared.accountNonce,
          prepared.height,
        );
      }
      live();
      // Always observe saved bytes first. A timeout, missing receipt or expired TTL
      // never authorizes a replacement signature or releases the account nonce.
      const observation = await this.node.observe(claim);
      live();
      if (observation.state === 'settled') {
        await this.boundary.settle(this.config, claim, observation.proof);
        settled = true;
      } else if (
        observation.state === 'absent' &&
        (await this.node.canBroadcast(claim))
      ) {
        live();
        const permitted = await this.boundary.authorizeBroadcast(
          this.config,
          claim,
        );
        live();
        if (permitted)
          await this.node.broadcast(
            permitted.rawTransaction,
            permitted.transactionHash,
          );
      }
    } finally {
      clearInterval(renewal);
      await renewing;
      // Shutdown leaves a recoverable lease to expire instead of starting more SQL.
      if (claim && !settled && !lost && !this.stopped)
        await this.boundary.release(this.config, claim).catch(() => undefined);
    }
  }
}
