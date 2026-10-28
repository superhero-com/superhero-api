import {
  BadRequestException,
  Inject,
  Injectable,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Encoding, isAddressValid } from '@aeternity/aepp-sdk';
import { ShortsChainService } from './shorts-chain.service';
import { ShortsWalletTransactionsService } from './shorts-wallet-transactions.service';
import { ShortsLikeSponsorshipRepository } from './shorts-like-sponsorship-repository.service';
import {
  LikeSponsorConfig,
  SHORTS_LIKE_SPONSOR_CONFIG,
} from './shorts-like-sponsorship.config';
import { likeInnerTransaction } from './shorts-like-sponsorship-transaction';
import { receiptHash } from './shorts-receipts.service';
import { shortsLikeMode } from './shorts-release';
import { proveSponsoredLikeExpiry } from './shorts-sponsored-observation';

/** HTTP admission owns no signing key and never broadcasts. */
@Injectable()
export class ShortsLikeSponsorshipService implements OnApplicationBootstrap {
  private ready = false;
  constructor(
    @Inject(SHORTS_LIKE_SPONSOR_CONFIG)
    private readonly config: LikeSponsorConfig,
    private readonly repository: ShortsLikeSponsorshipRepository,
    private readonly chain: ShortsChainService,
    private readonly observations: ShortsWalletTransactionsService,
  ) {}
  async onApplicationBootstrap() {
    if (!this.config.release) return;
    this.binding();
    if (
      shortsLikeMode(
        this.config.release,
        this.config.artifact,
        await this.chain.policy(),
      ) !== 'free'
    ) {
      throw new Error('Sponsorship requires the zero-payment Like release');
    }
    const binding = await this.repository.call('verify');
    this.ready = this.config.enabled && binding.kind === 'api';
  }
  async publicConfig() {
    if (!this.ready) return { enabled: false };
    try {
      const binding = await this.repository.call('verify');
      this.binding();
      if (binding.kind !== 'api' || binding.paused || binding.quarantined)
        return { enabled: false };
    } catch {
      return { enabled: false };
    }
    const { gasLimit, gasPrice, maxFee, ttlBlocks } = this.config.policy;
    return { enabled: true, gasLimit, gasPrice, maxFee, ttlBlocks };
  }
  private binding() {
    const c = this.config;
    if (
      !c.release ||
      this.chain.release.network !== c.release.network ||
      this.chain.state.contract !== c.release.contract ||
      this.chain.release.sourceHash !== c.release.sourceHash ||
      this.chain.release.bytecodeHash !== c.release.bytecodeHash
    ) {
      throw new ServiceUnavailableException(
        'Like sponsorship deployment is unavailable',
      );
    }
  }
  async enqueue(
    actor: string,
    request: { id: string; videoId: string; signedInnerTx: string },
  ) {
    this.binding();
    if (
      !request ||
      typeof request.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        request.id,
      )
    ) {
      throw new BadRequestException(
        'Invalid Like sponsorship request identifier',
      );
    }
    const c = this.config;
    // Validate the expensive/network-independent portion before asking the node.
    const inner = likeInnerTransaction(request.signedInnerTx, {
      actor,
      contract: c.release.contract,
      network: c.release.network,
      policy: c.policy,
      videoId: request.videoId,
    });
    // Exact retries remain idempotent even after the original TTL passes.
    const existing = await this.repository.call('status', {
      actor,
      innerHash: inner.innerHash,
    });
    if (!existing) {
      const [head, policy] = await Promise.all([
        this.chain.readNode(() => this.chain.sdk.api.getCurrentKeyBlock()),
        this.chain.policy(),
      ]);
      this.binding();
      if (shortsLikeMode(c.release, c.artifact, policy) !== 'free') {
        throw new BadRequestException(
          'Like policy changed; no sponsorship was accepted',
        );
      }
      if (
        !Number.isSafeInteger(head.height) ||
        inner.ttl > head.height + c.policy.ttlBlocks
      ) {
        throw new BadRequestException(
          'Like sponsorship expiry exceeds its limit',
        );
      }
      // Persist stale/expired requests too: only the durable worker rejection
      // proves no outer signature exists after a lost POST acknowledgement.
    }
    await this.repository.call('enqueue', {
      id: request.id,
      actor,
      videoId: inner.videoId,
      innerHash: inner.innerHash,
      rawInner: request.signedInnerTx,
      intent: { nonce: inner.nonce, ttl: inner.ttl, version: inner.version },
    });
    return this.observe(inner.innerHash, actor, c.release.contract);
  }
  async observe(innerHash: string, actor: string, contract: string) {
    this.binding();
    receiptHash(innerHash);
    if (
      !isAddressValid(actor, Encoding.AccountAddress) ||
      contract !== this.config.release.contract
    ) {
      throw new BadRequestException('Invalid sponsorship scope');
    }
    const base = {
      tx: innerHash,
      address: actor,
      contract,
      network: this.config.release.network,
      sponsored: true,
      confirmationsRequired: 3,
      confirmations: 0,
      status: 'unknown',
    };
    const row = await this.repository.call('status', { actor, innerHash });
    if (!row) return base;
    const identity = {
      ...base,
      method: 'like',
      amount: '0',
      videoId: row.videoId,
      nonce: row.intent.nonce,
      args: [row.videoId, row.intent.version],
      sponsorshipStatus: row.status,
    };
    if (!row.outerHash)
      return {
        ...identity,
        ...(row.status === 'rejected' ? { neverSubmitted: true } : {}),
      };
    const observed = await this.observations.observe(
      row.outerHash,
      actor,
      contract,
    );
    if (
      row.status === 'expired' &&
      ['unknown', 'reorged'].includes(observed.status)
    ) {
      const expiryProof = await this.chain.readNode(() =>
        proveSponsoredLikeExpiry(
          this.chain.sdk.api,
          {
            outerHash: row.outerHash,
            ttl: row.intent.ttl,
            payer: this.config.payer,
            payerNonce:
              row.expiryProof.reservedNonce ?? row.expiryProof.payerNonce + 1,
            allowNonceGap: row.expiryProof.reservedNonce !== undefined,
            network: this.config.release.network,
          },
          row.expiryProof,
        ),
      );
      if (expiryProof)
        return {
          ...identity,
          sponsoredTx: row.outerHash,
          sponsorshipExpired: true,
          expiryProof,
        };
    }
    // Unknown on the node remains unknown; a saved outer hash is no mining proof.
    if (observed.status === 'unknown')
      return { ...identity, sponsoredTx: row.outerHash };
    if (
      !('innerHash' in observed) ||
      observed.innerHash !== innerHash ||
      observed.method !== 'like' ||
      observed.videoId !== row.videoId ||
      observed.nonce !== row.intent.nonce ||
      observed.amount !== '0' ||
      JSON.stringify(observed.args) !== JSON.stringify(identity.args)
    )
      throw new Error('Sponsorship mapping changed');
    return {
      ...observed,
      tx: innerHash,
      sponsored: true,
      sponsoredTx: row.outerHash,
      sponsorshipStatus: row.status,
    };
  }
}
