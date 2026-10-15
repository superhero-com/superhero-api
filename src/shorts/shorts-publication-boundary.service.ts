import { ShortsDatabaseService } from './shorts-database.service';
import {
  Inject,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  isAeAccountAddress,
  isAeContractAddress,
} from '../common/validation/request-validation';
import { ShortsScope } from './shorts-metadata.service';
import { PublicationClaim } from './shorts-publications.service';
import {
  publicationTransaction,
  PublishingPolicy,
  publishingPolicy,
} from './shorts-publication-transaction';
import { receiptHash } from './shorts-receipts.service';

export interface PublishingDeployment {
  scope: ShortsScope;
  sourceHash: string;
  operator: string;
  policy: PublishingPolicy;
}
export interface SignedPublicationClaim extends PublicationClaim {
  nonce?: number;
  ttl?: number;
  reservedCost?: string;
  broadcastBlocked?: boolean;
}

/** Both roles use only this scoped function; neither receives journal table grants. */
@Injectable()
export class ShortsPublicationBoundaryService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}
  private async call(
    deployment: PublishingDeployment,
    action: string,
    data: object = {},
  ) {
    if (
      deployment?.scope?.network !== 'ae_uat' ||
      !isAeContractAddress(deployment.scope.contract) ||
      !isAeAccountAddress(deployment.operator) ||
      !/^[a-f0-9]{64}$/.test(deployment.sourceHash)
    )
      throw new BadRequestException('Invalid publication deployment');
    try {
      return await this.db.transaction(async (db) => {
        await db.query(
          "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'",
        );
        const [{ result }] = await db.query(
          'SELECT shorts_publication($1,$2::jsonb) AS result',
          [
            action,
            JSON.stringify({
              ...data,
              ...deployment.scope,
              sourceHash: deployment.sourceHash,
              operator: deployment.operator,
              policy: publishingPolicy(deployment.policy),
            }),
          ],
        );
        return result;
      });
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (code === 'SH400')
        throw new BadRequestException('Invalid publication operation');
      if (code === 'SH401')
        throw new ForbiddenException(
          'Publication authority or content approval is unavailable',
        );
      if (code === 'SH409')
        throw new ConflictException(
          'Publication identity, lease or observation changed',
        );
      if (code === 'SH503')
        throw new ServiceUnavailableException(
          'Publication is paused or its budget is full',
        );
      throw error;
    }
  }
  async verify(deployment: PublishingDeployment, kind: 'api' | 'publisher') {
    const expected = publishingPolicy(deployment.policy);
    const binding = await this.call(deployment, 'verify');
    const actual = publishingPolicy(binding.policy);
    if (
      binding.kind !== kind ||
      binding.operator !== deployment.operator ||
      binding.preparationCapacityVersion !== 1 ||
      JSON.stringify(actual) !== JSON.stringify(expected)
    )
      throw new ForbiddenException(
        'Publisher identity or configured limits changed',
      );
  }
  async enqueue(deployment: PublishingDeployment, id: string, creator: string) {
    if (!isAeAccountAddress(creator))
      throw new BadRequestException('Invalid creator');
    return this.call(deployment, 'enqueue', { id, creator });
  }
  async status(deployment: PublishingDeployment, id: string, creator: string) {
    if (!isAeAccountAddress(creator))
      throw new BadRequestException('Invalid creator');
    return this.call(deployment, 'status', { id, creator });
  }
  async capacity(
    deployment: PublishingDeployment,
    id: string,
    creator: string,
  ) {
    if (!isAeAccountAddress(creator))
      throw new BadRequestException('Invalid creator');
    const result = await this.call(deployment, 'capacity', { id, creator });
    if (!result || typeof result.ready !== 'boolean')
      throw new ServiceUnavailableException('Publication capacity is unknown');
    return result.ready;
  }
  private saved(
    deployment: PublishingDeployment,
    claim: SignedPublicationClaim,
  ) {
    if (
      claim.status !== 'signed' ||
      !Number.isSafeInteger(claim.nonce) ||
      !Number.isSafeInteger(claim.ttl)
    )
      throw new ServiceUnavailableException(
        'Signed publication record is incomplete',
      );
    // Historical bytes must be verified even when expired. This does not authorize
    // broadcast: the runner must freshly check chain state, TTL and policy first.
    const tx = publicationTransaction(
      claim.rawTransaction,
      claim.intent,
      deployment.scope.contract,
      deployment.operator,
      claim.nonce - 1,
      claim.ttl - 1,
      deployment.policy,
      deployment.scope.network,
    );
    if (
      tx.hash !== claim.transactionHash ||
      tx.nonce !== claim.nonce ||
      tx.ttl !== claim.ttl ||
      tx.cost !== claim.reservedCost
    )
      throw new ServiceUnavailableException(
        'Signed publication record failed validation',
      );
    return tx;
  }
  async claim(
    deployment: PublishingDeployment,
  ): Promise<SignedPublicationClaim | undefined> {
    await this.verify(deployment, 'publisher');
    const claim = await this.call(deployment, 'claim');
    if (!claim) return;
    if (claim.status === 'signed') this.saved(deployment, claim);
    else if (
      claim.status !== 'claimed' ||
      claim.rawTransaction ||
      claim.transactionHash
    )
      throw new ServiceUnavailableException(
        'Publication record failed validation',
      );
    return claim;
  }
  async persistSigned(
    deployment: PublishingDeployment,
    claim: PublicationClaim,
    rawTransaction: string,
    accountNonce: number,
    height: number,
  ) {
    const tx = publicationTransaction(
      rawTransaction,
      claim.intent,
      deployment.scope.contract,
      deployment.operator,
      accountNonce,
      height,
      deployment.policy,
      deployment.scope.network,
    );
    const result = await this.call(deployment, 'persist', {
      id: claim.id,
      intent: claim.intent,
      token: claim.token,
      fence: claim.fence,
      rawTransaction,
      transactionHash: tx.hash,
      nonce: tx.nonce,
      ttl: tx.ttl,
      cost: tx.cost,
      accountNonce,
      height,
    });
    if (result.transactionHash !== tx.hash)
      throw new ConflictException('Signed publication identity changed');
    return {
      ...claim,
      status: 'signed' as const,
      rawTransaction,
      transactionHash: tx.hash,
      nonce: tx.nonce,
      ttl: tx.ttl,
      reservedCost: tx.cost,
    };
  }
  async authorizeBroadcast(
    deployment: PublishingDeployment,
    claim: SignedPublicationClaim,
  ) {
    const tx = this.saved(deployment, claim);
    const result = await this.call(deployment, 'authorize', {
      id: claim.id,
      token: claim.token,
      fence: claim.fence,
    });
    if (!result) return;
    if (result.transactionHash !== tx.hash)
      throw new ConflictException('Publication payload changed');
    this.saved(deployment, result);
    return { rawTransaction: result.rawTransaction, transactionHash: tx.hash };
  }
  async renew(deployment: PublishingDeployment, claim: PublicationClaim) {
    await this.call(deployment, 'renew', {
      id: claim.id,
      token: claim.token,
      fence: claim.fence,
    });
  }
  async release(deployment: PublishingDeployment, claim: PublicationClaim) {
    await this.call(deployment, 'release', {
      id: claim.id,
      token: claim.token,
      fence: claim.fence,
    });
  }
  async reconcile(
    deployment: PublishingDeployment,
    claim: PublicationClaim,
    proof: { blockHash: string; height: number; tipHeight: number },
  ) {
    receiptHash(proof.blockHash, 'kh_');
    await this.call(deployment, 'reconcile', {
      ...proof,
      id: claim.id,
      intent: claim.intent,
      token: claim.token,
      fence: claim.fence,
    });
  }
  async settle(
    deployment: PublishingDeployment,
    claim: PublicationClaim,
    proof: {
      transactionHash: string;
      blockHash: string;
      height: number;
      tipHeight: number;
      result: 'ok' | 'revert' | 'error';
    },
  ) {
    receiptHash(proof.transactionHash);
    receiptHash(proof.blockHash, 'mh_');
    await this.call(deployment, 'settle', {
      ...proof,
      id: claim.id,
      token: claim.token,
      fence: claim.fence,
    });
  }
}
