import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  AccountMemory,
  AeSdk,
  buildTxAsync,
  Contract,
  Node,
  Tag,
  rebuildUnpackedTx,
} from '@aeternity/aepp-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  LikeSponsorConfig,
  SHORTS_LIKE_SPONSOR_CONFIG,
} from './shorts-like-sponsorship.config';
import { ShortsLikeSponsorshipRepository } from './shorts-like-sponsorship-repository.service';
import {
  likeInnerTransaction,
  sponsoredLikeTransaction,
  unsignedSponsoredLikeTransaction,
} from './shorts-like-sponsorship-transaction';
import {
  observeSponsoredLike,
  proveSponsoredLikeExpiry,
} from './shorts-sponsored-observation';
import { shortsConfigJson, shortsLikeMode } from './shorts-release';
import { shortsContractPolicy } from './shorts-contract-policy';
import { publisherTransport } from './shorts-publisher-node.service';
import { PublisherAttempt } from './shorts-publisher-attempt';

/** Isolated fee payer. The HTTP API cannot load this provider or access its key. */
@Injectable()
export class ShortsLikeSponsorWorker
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ShortsLikeSponsorWorker.name);
  private readonly shutdown = new AbortController();
  private account: AccountMemory;
  private node: Node;
  private contract: Contract<any>;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  constructor(
    @Inject(SHORTS_LIKE_SPONSOR_CONFIG)
    private readonly config: LikeSponsorConfig,
    private readonly repository: ShortsLikeSponsorshipRepository,
  ) {}
  async onModuleInit() {
    const c = this.config;
    if (!c.release || !c.keyFile)
      throw new Error('Isolated sponsorship configuration required');
    try {
      const key = await shortsConfigJson(c.keyFile, true);
      this.account = new AccountMemory(key.secretKey);
    } catch {
      throw new Error('Like sponsor key file is invalid');
    }
    if (this.account.address !== c.payer)
      throw new Error('Like sponsor key identity mismatch');
    this.node = new Node(c.release.node, {
      retryCount: 0,
      httpClient: publisherTransport(c.release.node),
    });
    const sdk = new AeSdk({
      nodes: [{ name: 'like-sponsor', instance: this.node }],
    });
    this.contract = await Contract.initialize({
      ...sdk.getContext(),
      aci: c.artifact.aci,
      address: c.release.contract,
    });
    await this.verify();
  }
  private async verify() {
    const c = this.config;
    if ((await this.node.getStatus()).networkId !== c.release.network)
      throw new Error('Like sponsor network changed');
    const code = await this.node.getContractCode(c.release.contract);
    if (
      createHash('sha256').update(code.bytecode).digest('hex') !==
      c.artifact.bytecodeHash
    )
      throw new Error('Like sponsor bytecode mismatch');
    const policy = shortsContractPolicy(
      (await this.contract.$call('get_config', [], { callStatic: true }))
        .decodedResult,
      2,
    );
    if (
      shortsLikeMode(c.release, c.artifact, policy) !== 'free' ||
      [policy.operator, policy.treasury].includes(c.payer)
    )
      throw new Error('Like sponsor contract authority changed');
    const owners = (
      await this.contract.$call('get_owner', [], { callStatic: true })
    ).decodedResult;
    if (!Array.isArray(owners) || owners.includes(c.payer))
      throw new Error('Fee payer must not be contract owner');
    return policy;
  }
  onApplicationBootstrap() {
    if (this.config.recovery) return;
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref();
    void this.tick();
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    this.shutdown.abort();
    await this.pending;
  }
  tick() {
    if (this.shutdown.signal.aborted) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.run()
      .catch(() => {
        // SDK errors may contain signed transactions; never log them.
        this.logger.warn(
          'Like sponsorship deferred; its durable journal remains pending.',
        );
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async run() {
    const attempt = new PublisherAttempt(this.shutdown.signal, 45000);
    try {
      await attempt.run(() => this.process(attempt));
    } finally {
      attempt.close();
    }
  }
  /** Every spend extends a verified canonical prefix; a missing node response never releases it. */
  private async verifyAnchor(
    attempt: PublisherAttempt,
  ): Promise<number | undefined> {
    const anchor = await this.repository.call('anchor');
    attempt.check();
    if (anchor.quarantined && !this.config.recovery) return undefined;
    if (!Number.isSafeInteger(anchor.version) || anchor.version < 0)
      throw new Error('Invalid sponsor anchor version');
    const job = anchor.job;
    if (!job) return anchor.version;
    const c = this.config;
    const expected = {
      actor: job.actor,
      contract: job.contract,
      network: c.release.network,
      policy: c.policy,
      payer: c.payer,
    };
    const inner = likeInnerTransaction(job.raw_inner, expected);
    const outer = sponsoredLikeTransaction(job.raw_outer, job.raw_inner, {
      ...expected,
      payerNonce: Number(job.payer_nonce),
    });
    if (
      inner.innerHash !== job.inner_hash ||
      outer.outerHash !== job.outer_hash ||
      outer.cost !== job.reserved_cost
    )
      throw new Error('Sponsor anchor journal changed');
    let changed = false;
    if (job.status === 'expired') {
      const proof = await proveSponsoredLikeExpiry(
        this.node,
        {
          outerHash: outer.outerHash,
          ttl: inner.ttl,
          payer: c.payer,
          payerNonce: outer.payerNonce,
          network: c.release.network,
          allowNonceGap: job.expiry_proof.reservedNonce !== undefined,
        },
        job.expiry_proof,
      );
      if (!proof) {
        const block = await this.node.getKeyBlockByHeight(
          job.expiry_proof.height,
        );
        changed = block.hash !== job.expiry_proof.blockHash;
      } else return anchor.version;
    } else {
      const observed = await observeSponsoredLike(
        this.node,
        job.raw_outer,
        job.raw_inner,
        expected,
      );
      attempt.check();
      if (
        ['confirmed', 'failed'].includes(observed.status) &&
        'blockHash' in observed &&
        'result' in observed &&
        observed.blockHash === job.block_hash &&
        observed.blockHeight === Number(job.block_height) &&
        observed.result === job.result
      )
        return anchor.version;
      const generation = await this.node.getGenerationByHeight(
        Number(job.block_height),
      );
      changed = !generation.microBlocks.includes(job.block_hash);
    }
    attempt.check();
    if (changed)
      await this.repository.call('quarantine', {
        anchorVersion: anchor.version,
        reason: 'anchor_changed',
      });
    throw new Error(
      'Sponsor canonical prefix is unresolved; new signatures are blocked',
    );
  }
  async finishRecovery() {
    if (!this.config.recovery)
      throw new Error('Explicit recovery mode required');
    const attempt = new PublisherAttempt(this.shutdown.signal, 45000);
    try {
      await attempt.run(async () => {
        const version = await this.verifyAnchor(attempt);
        if (version === undefined)
          throw new Error('Recovery anchor unavailable');
        await this.repository.call('recovery_finish', {
          anchorVersion: version,
          recovery: true,
          admissionEnabled: false,
        });
      });
    } finally {
      attempt.close();
    }
  }
  private async process(attempt: PublisherAttempt) {
    const c = this.config;
    let job: any;
    let settled = false;
    let anchorVersion: number | undefined;
    const args = () => ({
      innerHash: job.inner_hash,
      token: job.lease_token,
      fence: job.fence,
      anchorVersion,
      recovery: c.recovery === true,
    });
    try {
      attempt.check();
      const began = performance.now();
      anchorVersion = await this.verifyAnchor(attempt);
      if (anchorVersion === undefined) return;
      job = await this.repository.call(
        c.recovery ? 'claim_recovery' : 'claim',
        { token: randomUUID(), anchorVersion, recovery: c.recovery === true },
      );
      if (!job) return;
      if (c.recovery && !job.raw_outer)
        throw new Error('Recovery never creates new signatures');
      attempt.lease(began, 60000);
      const policy = await this.verify();
      attempt.check();
      const expected = {
        actor: job.actor,
        contract: c.release.contract,
        network: c.release.network,
        policy: c.policy,
        payer: c.payer,
      };
      // SQL admission is not signature authority: the signer independently decodes every byte.
      let inner;
      try {
        inner = likeInnerTransaction(job.raw_inner, {
          ...expected,
          videoId: job.video_id,
        });
      } catch (error) {
        if (job.raw_outer) throw error;
        await this.repository.call('reject', args());
        settled = true;
        return;
      }
      if (
        inner.innerHash !== job.inner_hash ||
        inner.version !== job.intent.version ||
        inner.nonce !== job.intent.nonce ||
        inner.ttl !== job.intent.ttl
      ) {
        if (job.raw_outer)
          throw new Error('Sponsorship journal identity changed');
        await this.repository.call('reject', args());
        settled = true;
        return;
      }
      if (!job.raw_outer) {
        const head = await this.node.getTopHeader();
        if (
          inner.ttl <= head.height ||
          inner.ttl > head.height + c.policy.ttlBlocks ||
          !policy.likesEnabled ||
          policy.version !== inner.version
        ) {
          await this.repository.call('reject', args());
          settled = true;
          return;
        }
        const status = (
          await this.contract.$call('migration_status', [], {
            callStatic: true,
            top: head.hash as `kh_${string}` | `mh_${string}`,
          })
        ).decodedResult;
        attempt.check();
        if (
          inner.ttl <= head.height ||
          inner.ttl > head.height + c.policy.ttlBlocks ||
          !policy.likesEnabled ||
          policy.version !== inner.version ||
          status.importing ||
          status.abandoned ||
          status.frozen
        ) {
          await this.repository.call('reject', args());
          settled = true;
          return;
        }
        // Require the current basic-account nonce; a conflicting user transaction must never drain sponsor funds.
        let actorNonce = 0;
        try {
          const actor = await this.node.getAccountByPubkeyAndHash(
            inner.actor as `ak_${string}`,
            head.hash,
          );
          if (actor.kind !== 'basic') {
            await this.repository.call('reject', args());
            settled = true;
            return;
          }
          actorNonce = actor.nonce;
        } catch (error) {
          if (
            !error ||
            typeof error !== 'object' ||
            !('statusCode' in error) ||
            error.statusCode !== 404
          )
            throw error;
        }
        if (inner.nonce !== actorNonce + 1) {
          if ((await this.node.getTopHeader()).hash !== head.hash)
            throw new Error('Like nonce snapshot changed');
          await this.repository.call('reject', args());
          settled = true;
          return;
        }
        // Simulate these exact user-signed bytes. Account balance override is
        // local dry-run state only; no funding transaction is sent.
        const dryRun = await this.node.protectedDryRunTxs({
          top: head.hash,
          txs: [{ tx: rebuildUnpackedTx(inner.call) }],
          accounts: [
            {
              pubKey: inner.actor as `ak_${string}`,
              amount: 1000000000000000000000000n,
            },
          ],
        });
        attempt.check();
        if (!Array.isArray(dryRun.results) || dryRun.results.length !== 1)
          throw new Error('Invalid sponsor dry-run response');
        const simulation = dryRun.results[0];
        if (!['ok', 'error'].includes(simulation.result))
          throw new Error('Missing sponsor dry-run result');
        if (
          simulation.result !== 'ok' ||
          ['revert', 'error'].includes(simulation.callObj?.returnType)
        ) {
          if ((await this.node.getTopHeader()).hash !== head.hash)
            throw new Error('Like preflight top changed');
          await this.repository.call('reject', args());
          settled = true;
          return;
        }
        if (
          simulation.callObj?.returnType !== 'ok' ||
          simulation.callObj.callerId !== inner.actor ||
          simulation.callObj.contractId !== c.release.contract ||
          simulation.callObj.callerNonce !== inner.nonce
        ) {
          throw new Error('Sponsor dry-run identity changed');
        }
        const payer = await this.node.getAccountByPubkey(
          c.payer as `ak_${string}`,
        );
        if (payer.kind !== 'basic')
          throw new Error('Sponsor requires a basic account');
        const nonce = job.prepared_outer
          ? Number(job.prepared_nonce)
          : payer.nonce + 1;
        if (nonce !== payer.nonce + 1) {
          // No persisted signed outer can have escaped this worker. Retain the
          // unsigned reservation as audit evidence, but release this stale job.
          await this.repository.call('reject', args());
          settled = true;
          return;
        }
        const unsigned =
          job.prepared_outer ??
          (await buildTxAsync({
            tag: Tag.PayingForTx,
            payerId: c.payer as `ak_${string}`,
            nonce,
            tx: job.raw_inner,
            onNode: this.node,
          }));
        let reservation;
        try {
          reservation = unsignedSponsoredLikeTransaction(
            unsigned,
            job.raw_inner,
            {
              ...expected,
              payerNonce: nonce,
            },
          );
        } catch (error) {
          if (job.prepared_outer) throw error;
          await this.repository.call('reject', args());
          settled = true;
          return;
        }
        if (BigInt(payer.balance) < BigInt(reservation.cost))
          throw new Error('Sponsor balance below reserved cost');
        attempt.check();
        // This operation atomically reserves exact bytes, nonce and budget. It
        // rechecks signer authority/admission even when recovering a reservation.
        job = await this.repository.call('reserve', {
          ...args(),
          unsignedOuter: unsigned,
          nonce,
          cost: reservation.cost,
        });
        if (
          job.prepared_outer !== unsigned ||
          Number(job.prepared_nonce) !== nonce ||
          job.prepared_cost !== reservation.cost
        )
          throw new Error('Sponsor reservation changed');
        attempt.check();
        anchorVersion = await this.verifyAnchor(attempt);
        if (anchorVersion === undefined)
          throw new Error('Sponsor quarantined before signing');
        const rawOuter = await this.account.signTransaction(
          job.prepared_outer,
          {
            networkId: c.release.network,
          },
        );
        const outer = sponsoredLikeTransaction(rawOuter, job.raw_inner, {
          ...expected,
          payerNonce: nonce,
        });
        if (outer.cost !== reservation.cost)
          throw new Error('Signed sponsor cost changed');
        attempt.check();
        job = await this.repository.call('persist', {
          ...args(),
          unsignedOuter: unsigned,
          rawOuter,
          outerHash: outer.outerHash,
          nonce,
          cost: outer.cost,
        });
      }
      const outer = sponsoredLikeTransaction(job.raw_outer, job.raw_inner, {
        ...expected,
        payerNonce: Number(job.payer_nonce),
      });
      if (
        outer.outerHash !== job.outer_hash ||
        outer.cost !== job.reserved_cost
      )
        throw new Error('Saved sponsor envelope changed');
      const observation = await observeSponsoredLike(
        this.node,
        job.raw_outer,
        job.raw_inner,
        expected,
      );
      attempt.check();
      if (['confirmed', 'failed'].includes(observation.status)) {
        if (
          !('blockHash' in observation) ||
          !('blockHeight' in observation) ||
          !('result' in observation)
        )
          throw new Error('Missing sponsor settlement proof');
        anchorVersion = await this.verifyAnchor(attempt);
        if (anchorVersion === undefined)
          throw new Error('Sponsor quarantined before settlement');
        await this.repository.call('settle', {
          ...args(),
          outerHash: outer.outerHash,
          blockHash: observation.blockHash,
          height: observation.blockHeight,
          result: observation.result,
        });
        settled = true;
      } else if (['unknown', 'reorged'].includes(observation.status)) {
        const expiryIdentity = {
          outerHash: outer.outerHash,
          ttl: inner.ttl,
          payer: c.payer,
          payerNonce: outer.payerNonce,
          network: c.release.network,
          allowNonceGap: c.recovery === true,
        };
        // A proven expired nonce may already have been reused. Revalidate its
        // retained historical anchor before asking the current nonce to be unused.
        let expiryProof;
        if (c.recovery) {
          for (const prior of [...(job.settlement_history ?? [])].reverse()) {
            if (prior.status !== 'expired' || !prior.expiryProof) continue;
            expiryProof = await proveSponsoredLikeExpiry(
              this.node,
              {
                ...expiryIdentity,
                allowNonceGap: prior.expiryProof.reservedNonce !== undefined,
              },
              prior.expiryProof,
            );
            if (expiryProof) break;
          }
        }
        expiryProof ??= await proveSponsoredLikeExpiry(
          this.node,
          expiryIdentity,
        );
        attempt.check();
        if (expiryProof) {
          anchorVersion = await this.verifyAnchor(attempt);
          if (anchorVersion === undefined)
            throw new Error('Sponsor quarantined before expiry');
          await this.repository.call('expire', { ...args(), expiryProof });
          settled = true;
          return;
        }
        if (observation.status !== 'unknown' && !c.recovery) return;
        const [head, payer] = await Promise.all([
          this.node.getCurrentKeyBlock(),
          this.node.getAccountByPubkey(c.payer as `ak_${string}`),
        ]);
        attempt.check();
        // TTL/nonce uncertainty never authorizes replacement bytes or a released budget.
        if (
          inner.ttl <= head.height ||
          payer.kind !== 'basic' ||
          !Number.isSafeInteger(payer.nonce) ||
          payer.nonce + 1 !== outer.payerNonce ||
          !policy.likesEnabled ||
          policy.version !== inner.version
        )
          return;
        anchorVersion = await this.verifyAnchor(attempt);
        if (anchorVersion === undefined)
          throw new Error('Sponsor quarantined before broadcast');
        // Recheck canonical absence and the exact next nonce at a stable key
        // block before an explicit recovery can rebroadcast an orphaned envelope.
        const current = await observeSponsoredLike(
          this.node,
          job.raw_outer,
          job.raw_inner,
          expected,
        );
        const [sameHead, samePayer] = await Promise.all([
          this.node.getCurrentKeyBlock(),
          this.node.getAccountByPubkey(c.payer as `ak_${string}`),
        ]);
        attempt.check();
        if (
          !['unknown', ...(c.recovery ? ['reorged'] : [])].includes(
            current.status,
          ) ||
          sameHead.hash !== head.hash ||
          sameHead.height !== head.height ||
          samePayer.kind !== 'basic' ||
          samePayer.nonce !== payer.nonce
        )
          return;
        if (await this.repository.call('authorize', args())) {
          attempt.check();
          const response = await this.node.postTransaction({
            tx: job.raw_outer,
          });
          if (response.txHash !== outer.outerHash)
            throw new Error('Sponsor broadcast hash mismatch');
        }
      }
    } finally {
      if (job && !settled && !attempt.signal.aborted)
        await this.repository.call('release', args()).catch(() => undefined);
    }
  }
}
