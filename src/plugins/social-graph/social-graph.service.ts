import {
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Encoded } from '@aeternity/aepp-sdk';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { SocialGraphReader, decimal } from './social-graph-reader';
import { SocialGraphQueryService } from './social-graph-query.service';

export function safeGraphNumber(value: unknown): number {
  const number = Number(decimal(value));
  if (!Number.isSafeInteger(number))
    throw new ServiceUnavailableException(
      'Graph integer exceeds the supported client range',
    );
  return number;
}

@Injectable()
export class SocialGraphService implements OnModuleInit {
  private reader?: SocialGraphReader;
  constructor(
    private readonly ae: AeSdkService,
    private readonly queries: SocialGraphQueryService,
  ) {}

  isConfigured(): boolean {
    return Boolean(process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS);
  }

  async onModuleInit(): Promise<void> {
    if (this.isConfigured()) await this.getReader().verifyIdentity();
  }

  getReader(): SocialGraphReader {
    if (this.reader) return this.reader;
    const contract = process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS;
    const network = process.env.SOCIAL_GRAPH_NETWORK_ID;
    if (!contract || !network)
      throw new ServiceUnavailableException(
        'Social graph contract and network are not configured',
      );
    if (!/^ct_[1-9A-HJ-NP-Za-km-z]+$/.test(contract))
      throw new ServiceUnavailableException(
        'Invalid social contract configuration',
      );
    this.reader = new SocialGraphReader(this.ae.sdk.getContext().onNode, {
      contract: contract as Encoded.ContractAddress,
      network,
    });
    return this.reader;
  }

  async getFollowCounts(address: string) {
    const reader = this.getReader();
    await reader.verifyIdentity();
    const { network, contract } = reader.identity;
    const counts = await this.queries.counts(
      await this.queries.ready(network, contract),
      address,
    );
    return {
      followers_count: safeGraphNumber(counts.followers),
      following_count: safeGraphNumber(counts.following),
    };
  }

  async getConfig() {
    const policy = await this.getReader().policy();
    return {
      max_following: safeGraphNumber(policy.config.max_following),
      max_blocked: safeGraphNumber(policy.config.max_blocked),
      follow_cooldown: safeGraphNumber(policy.config.follow_cooldown),
      contract_address: policy.contract,
    };
  }
}
