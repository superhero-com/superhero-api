import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { AccountMemory, AeSdk, Contract, Node } from '@aeternity/aepp-sdk';
import { createHttpHeaders, HttpClient } from '@azure/core-rest-pipeline';
import { createHash } from 'node:crypto';
import {
  SHORTS_PUBLISHER_CONFIG,
  ShortsPublisherConfig,
  publisherJson,
} from './shorts-publisher.config';
import {
  PublicationIntent,
  publicationCalldata,
} from './shorts-publication-transaction';
import { SignedPublicationClaim } from './shorts-publication-boundary.service';
import { receiptHash } from './shorts-receipts.service';
import { currentPublisherAttempt } from './shorts-publisher-attempt';
import { assertShortsReleaseConfig } from './shorts-release';

/** No redirects, implicit retries, unbounded response bodies or ambient credentials. */
export function publisherTransport(
  origin: string,
  timeoutMs = 8000,
): HttpClient {
  return {
    async sendRequest(request) {
      const attempt = currentPublisherAttempt();
      const url = new URL(request.url);
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        !url.pathname.startsWith('/v3/') ||
        !['GET', 'POST'].includes(request.method) ||
        (request.method === 'POST' &&
          !['/v3/dry-run', '/v3/transactions'].includes(url.pathname))
      )
        throw new Error('Publisher node request outside its authority');
      if (
        request.body != null &&
        (typeof request.body !== 'string' || request.body.length > 131072)
      )
        throw new Error('Publisher request is too large');
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, timeoutMs);
      request.abortSignal?.addEventListener('abort', abort);
      attempt?.signal.addEventListener('abort', abort, { once: true });
      if (request.abortSignal?.aborted) abort();
      try {
        attempt?.check();
        controller.signal.throwIfAborted();
        const response = await fetch(url, {
          method: request.method,
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: request.body as string | undefined,
          signal: controller.signal,
          redirect: 'error',
        });
        if (Number(response.headers.get('content-length') || 0) > 5242880)
          throw new Error('Publisher response is too large');
        const parts: Buffer[] = [];
        let length = 0;
        if (response.body)
          for await (const value of response.body as any) {
            length += value.byteLength;
            if (length > 5242880)
              throw new Error('Publisher response is too large');
            parts.push(Buffer.from(value));
          }
        attempt?.check();
        controller.signal.throwIfAborted();
        return {
          request,
          status: response.status,
          headers: createHttpHeaders(Object.fromEntries(response.headers)),
          bodyAsText: Buffer.concat(parts).toString('utf8'),
        };
      } finally {
        clearTimeout(timer);
        request.abortSignal?.removeEventListener('abort', abort);
        attempt?.signal.removeEventListener('abort', abort);
        controller.abort();
      }
    },
  };
}

@Injectable()
export class ShortsPublisherNodeService implements OnModuleInit {
  private account: AccountMemory;
  private node: Node;
  private contract: Contract<any>;
  constructor(
    @Inject(SHORTS_PUBLISHER_CONFIG)
    private readonly config: ShortsPublisherConfig,
  ) {}
  async onModuleInit() {
    const key = await publisherJson(this.config.keyFile, true);
    try {
      this.account = new AccountMemory(key.secretKey);
    } catch {
      throw new Error('Invalid publisher signing key');
    }
    if (this.account.address !== this.config.operator)
      throw new Error('Publisher key identity mismatch');
    this.node = new Node(this.config.nodeUrl, {
      retryCount: 0,
      httpClient: publisherTransport(this.config.nodeUrl),
    });
    const sdk = new AeSdk({
      nodes: [{ name: 'publisher', instance: this.node }],
    });
    this.contract = await Contract.initialize({
      ...sdk.getContext(),
      aci: this.config.artifact.aci,
      address: this.config.scope.contract as `ct_${string}`,
    });
    await this.verify();
  }
  async verify() {
    if ((await this.node.getStatus()).networkId !== this.config.release.network)
      throw new Error('Publisher network changed');
    const code = await this.node.getContractCode(this.config.scope.contract);
    if (
      createHash('sha256').update(code.bytecode).digest('hex') !==
      this.config.artifact.bytecodeHash
    )
      throw new Error('Publisher contract bytecode changed');
    const { decodedResult: cfg } = await this.contract.$call('get_config', [], {
      callStatic: true,
    });
    assertShortsReleaseConfig(this.config.release, cfg);
    const { decodedResult: previous } = await this.contract.$call(
      'get_previous',
      [],
      { callStatic: true },
    );
    if ((previous || null) !== this.config.release.previousContract)
      throw new Error('Publisher previous contract changed');
  }
  private async head() {
    if ((await this.node.getStatus()).networkId !== this.config.release.network)
      throw new Error('Publisher network changed');
    const head = await this.node.getCurrentKeyBlock();
    receiptHash(head.hash, 'kh_');
    if (!Number.isSafeInteger(head.height) || head.height < 0)
      throw new Error('Invalid node height');
    return head;
  }
  private matches(intent: PublicationIntent, value: any) {
    return (
      !!value &&
      !value.withdrawn &&
      value.creator === intent.creator &&
      value.cid === intent.cid &&
      BigInt(value.size) === BigInt(intent.bytes)
    );
  }
  private async generation(height: number) {
    const generation = await this.node.getGenerationByHeight(height);
    receiptHash(generation.keyBlock.hash, 'kh_');
    if (
      generation.keyBlock.height !== height ||
      !Array.isArray(generation.microBlocks)
    )
      throw new Error('Invalid canonical generation');
    for (const hash of generation.microBlocks) receiptHash(hash, 'mh_');
    return generation;
  }
  async existing(intent: PublicationIntent) {
    const tip = await this.head(),
      height = tip.height - this.config.policy.confirmations;
    if (height < 0) throw new Error('Chain has insufficient confirmations');
    const generation = await this.generation(height);
    const { decodedResult: value } = await this.contract.$call(
      'get_short',
      [intent.id],
      { callStatic: true, top: generation.keyBlock.hash as `kh_${string}` },
    );
    if (
      (await this.generation(height)).keyBlock.hash !== generation.keyBlock.hash
    )
      throw new Error('Publication observation changed during recovery');
    if (!value) {
      const latest = await this.contract.$call('get_short', [intent.id], {
        callStatic: true,
      });
      if (latest.decodedResult)
        throw new Error('Existing publication awaits confirmation');
      return undefined;
    }
    if (!this.matches(intent, value))
      throw new Error(
        'Existing publication conflicts with its immutable intent',
      );
    return {
      blockHash: generation.keyBlock.hash,
      height,
      tipHeight: tip.height,
    };
  }
  async prepare(intent: PublicationIntent) {
    await this.verify();
    const head = await this.head(),
      account = await this.node.getAccountByPubkey(this.config.operator);
    if (
      account.kind !== 'basic' ||
      !Number.isSafeInteger(account.nonce) ||
      account.nonce < 0 ||
      account.balance < BigInt(this.config.policy.maxTransactionCost)
    )
      throw new Error('Publisher account is unavailable or underfunded');
    // The SDK reads nonce from these options, although its public declaration omits it.
    const options = {
      callStatic: true,
      onAccount: this.account,
      nonce: account.nonce + 1,
      amount: 0,
      absoluteTtl: true,
      ttl: head.height + Math.min(30, this.config.policy.maxTtlBlocks),
      gasLimit: 1000000,
    };
    const simulation = await this.contract.$call(
      'publish',
      [intent.id, intent.creator, intent.cid, intent.bytes],
      options,
    );
    currentPublisherAttempt();
    return {
      rawTransaction: await this.account.signTransaction(simulation.rawTx, {
        networkId: this.config.release.network,
      }),
      accountNonce: account.nonce,
      height: head.height,
    };
  }
  async observe(claim: SignedPublicationClaim) {
    const tip = await this.head();
    let tx: Awaited<ReturnType<Node['getTransactionByHash']>>;
    try {
      tx = await this.node.getTransactionByHash(claim.transactionHash);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'statusCode' in error &&
        error.statusCode === 404
      )
        return { state: 'absent' as const };
      throw error;
    }
    if (
      tx.hash !== claim.transactionHash ||
      tx.tx.type !== 'ContractCallTx' ||
      tx.tx.callerId !== this.config.operator ||
      tx.tx.contractId !== this.config.scope.contract ||
      tx.tx.nonce !== claim.nonce ||
      tx.tx.callData !== publicationCalldata(claim.intent) ||
      BigInt(tx.tx.amount) !== 0n
    )
      throw new Error('Node returned a conflicting publication transaction');
    if (tx.blockHeight === -1) return { state: 'pending' as const };
    receiptHash(tx.blockHash, 'mh_');
    if (!Number.isSafeInteger(tx.blockHeight) || tx.blockHeight < 0)
      throw new Error('Invalid transaction height');
    if (tip.height - tx.blockHeight < this.config.policy.confirmations)
      return { state: 'pending' as const };
    const [generation, info, block] = await Promise.all([
      this.generation(tx.blockHeight),
      this.node.getTransactionInfoByHash(claim.transactionHash),
      this.node.getMicroBlockTransactionsByHash(tx.blockHash),
    ]);
    const call = info.callInfo;
    if (
      !generation.microBlocks.includes(tx.blockHash) ||
      !block.transactions.some((t) => t.hash === claim.transactionHash) ||
      !call ||
      call.callerId !== this.config.operator ||
      call.contractId !== this.config.scope.contract ||
      call.callerNonce !== claim.nonce ||
      call.height !== tx.blockHeight ||
      !['ok', 'error', 'revert'].includes(call.returnType)
    )
      throw new Error('Publication receipt is not canonical');
    const stable = await this.generation(tx.blockHeight);
    const after = await this.head();
    if (
      stable.keyBlock.hash !== generation.keyBlock.hash ||
      !stable.microBlocks.includes(tx.blockHash) ||
      after.height - tx.blockHeight < this.config.policy.confirmations
    )
      throw new Error('Publication confirmation changed');
    return {
      state: 'settled' as const,
      proof: {
        transactionHash: claim.transactionHash,
        blockHash: tx.blockHash,
        height: tx.blockHeight,
        tipHeight: after.height,
        result: call.returnType,
      },
    };
  }
  async canBroadcast(claim: SignedPublicationClaim) {
    const head = await this.head(),
      account = await this.node.getAccountByPubkey(this.config.operator);
    return (
      account.kind === 'basic' &&
      account.nonce === claim.nonce - 1 &&
      head.height < claim.ttl
    );
  }
  async broadcast(rawTransaction: string, transactionHash: string) {
    const result = await this.node.postTransaction({ tx: rawTransaction });
    if (result.txHash !== transactionHash)
      throw new Error('Publication submission hash mismatch');
  }
}
