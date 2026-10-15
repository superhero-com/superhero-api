import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ShortsChainService } from './shorts-chain.service';
import {
  ShortsPublicationBoundaryService,
  PublishingDeployment,
} from './shorts-publication-boundary.service';
import { publishingDeployment } from './shorts-publisher.config';
import { receiptHash } from './shorts-receipts.service';

/** Read/enqueue authority only. There is no signing account in this process. */
@Injectable()
export class ShortsApiPublicationService {
  private deployment?: PublishingDeployment;
  constructor(
    private readonly chain: ShortsChainService,
    private readonly boundary: ShortsPublicationBoundaryService,
  ) {}
  async initialize() {
    const deployment = await publishingDeployment();
    if (
      !this.chain.sharedReceipts ||
      this.chain.state.contract !== deployment.scope.contract ||
      this.chain.state.sourceHash !== deployment.sourceHash ||
      this.chain.operator.address !== deployment.operator
    )
      throw new Error('Hosted publication binding mismatch');
    await this.boundary.verify(deployment, 'api');
    this.deployment = deployment;
  }
  private ready() {
    if (!this.deployment)
      throw new ServiceUnavailableException(
        'Publisher connection is not initialized',
      );
    return this.deployment;
  }
  enqueue(id: string, creator: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.boundary.enqueue(this.ready(), id, creator);
  }
  async capacity(id: string, creator: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const ready = await this.boundary.capacity(this.ready(), id, creator);
    signal?.throwIfAborted();
    return ready;
  }
  async status(id: string, creator: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const deployment = this.ready();
    const job = await this.boundary.status(deployment, id, creator);
    signal?.throwIfAborted();
    if (!job || !['confirmed', 'reconciled'].includes(job.status)) return job;
    // Do not turn a durable observation into playback permission after a reorg.
    const height = Number(job.height);
    if (!Number.isSafeInteger(height) || height < 0)
      throw new ServiceUnavailableException('Invalid publication confirmation');
    receiptHash(job.blockHash, job.status === 'reconciled' ? 'kh_' : 'mh_');
    const observe = () =>
      Promise.all([
        this.chain.sdk.api.getCurrentKeyBlock(),
        this.chain.sdk.api.getGenerationByHeight(height),
        this.chain.sdk.api.getStatus(),
      ]);
    const [tip, generation, node] = await (signal
      ? this.chain.readNode(observe, signal)
      : observe());
    signal?.throwIfAborted();
    receiptHash(generation.keyBlock.hash, 'kh_');
    if (
      node.networkId !== deployment.scope.network ||
      !Number.isSafeInteger(tip.height) ||
      generation.keyBlock.height !== height ||
      !Array.isArray(generation.microBlocks) ||
      tip.height - height < deployment.policy.confirmations ||
      (job.status === 'reconciled'
        ? generation.keyBlock.hash !== job.blockHash
        : !generation.microBlocks.includes(job.blockHash))
    )
      throw new ServiceUnavailableException(
        'Publication confirmation needs reconciliation',
      );
    return job;
  }
}
