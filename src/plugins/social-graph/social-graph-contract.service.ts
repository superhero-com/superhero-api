import { AeSdkService } from '@/ae/ae-sdk.service';
import { Contract, Encoded } from '@aeternity/aepp-sdk';
import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { loadSocialContractAci } from './social-graph-aci';
import {
  SOCIAL_GRAPH_CONTRACT_ADDRESS,
  SOCIAL_GRAPH_EXPECTED_FOLLOW_COOLDOWN,
  SOCIAL_GRAPH_EXPECTED_MAX_BLOCKED,
  SOCIAL_GRAPH_EXPECTED_MAX_FOLLOWING,
} from './social-graph.constants';

export interface SocialGraphConfig {
  max_following: number;
  max_blocked: number;
  follow_cooldown: number;
  contract_address: string;
}

/**
 * On-chain reads for the SocialContract: the boot-time config assertion, the
 * config the API serves to clients, and the authoritative counters the
 * reconcile job checks the index against. This service never signs and never
 * holds a key — follow/unfollow/block/unblock are signed and broadcast by the
 * clients themselves (Model A).
 */
@Injectable()
export class SocialGraphContractService implements OnModuleInit {
  private readonly logger = new Logger(SocialGraphContractService.name);
  private readonly contractAddress = SOCIAL_GRAPH_CONTRACT_ADDRESS;
  private cachedContract: any | null = null;
  private verifiedConfig: SocialGraphConfig | null = null;

  constructor(private readonly aeSdkService: AeSdkService) {}

  isConfigured(): boolean {
    return Boolean(this.contractAddress);
  }

  /**
   * Boot assertion (ruled binding). When a contract is configured, read
   * get_config() and refuse to start unless it returns exactly the expected
   * triple. This is the real protection against being silently pointed at the
   * wrong contract — a class of bug that otherwise produces plausible, wrong
   * follower counts for weeks. A thrown init error aborts bootstrap.
   */
  async onModuleInit(): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.warn(
        'SocialGraph contract is not configured (SOCIAL_GRAPH_CONTRACT_ADDRESS missing) — social-graph endpoints disabled',
      );
      return;
    }

    const config = await this.readConfigFromChain();
    const expected = {
      max_following: SOCIAL_GRAPH_EXPECTED_MAX_FOLLOWING,
      max_blocked: SOCIAL_GRAPH_EXPECTED_MAX_BLOCKED,
      follow_cooldown: SOCIAL_GRAPH_EXPECTED_FOLLOW_COOLDOWN,
    };

    if (
      config.max_following !== expected.max_following ||
      config.max_blocked !== expected.max_blocked ||
      config.follow_cooldown !== expected.follow_cooldown
    ) {
      throw new Error(
        `SocialGraph get_config() mismatch at ${this.contractAddress}: ` +
          `got (${config.max_following}, ${config.max_blocked}, ${config.follow_cooldown}), ` +
          `expected (${expected.max_following}, ${expected.max_blocked}, ${expected.follow_cooldown}). ` +
          'Refusing to boot against an unexpected contract.',
      );
    }

    this.verifiedConfig = { ...config, contract_address: this.contractAddress };
    this.logger.log(
      `SocialGraph contract verified at ${this.contractAddress}: ` +
        `config (${config.max_following}, ${config.max_blocked}, ${config.follow_cooldown})`,
    );
  }

  /**
   * The boot-verified config, served to clients so the UI can render
   * `9 998 / 10 000` and disable a control before the user signs a transaction
   * that would abort. Never a per-request chain read.
   */
  getConfig(): SocialGraphConfig {
    if (!this.verifiedConfig) {
      throw new ServiceUnavailableException(
        'SocialGraph contract is not configured',
      );
    }
    return this.verifiedConfig;
  }

  async getFollowersCount(address: string): Promise<number> {
    const contract = await this.getContractInstance();
    const result: any = await contract.get_followers_count(address);
    return Number(result?.decodedResult ?? result);
  }

  async getFollowingCount(address: string): Promise<number> {
    const contract = await this.getContractInstance();
    const result: any = await contract.get_following_count(address);
    return Number(result?.decodedResult ?? result);
  }

  private async readConfigFromChain(): Promise<{
    max_following: number;
    max_blocked: number;
    follow_cooldown: number;
  }> {
    const contract = await this.getContractInstance();
    const result: any = await contract.get_config();
    // get_config() returns a Sophia tuple (int, int, int) -> [bigint, bigint, bigint].
    const decoded = (result?.decodedResult ?? result) as [
      unknown,
      unknown,
      unknown,
    ];
    return {
      max_following: Number(decoded[0]),
      max_blocked: Number(decoded[1]),
      follow_cooldown: Number(decoded[2]),
    };
  }

  private async getContractInstance(): Promise<any> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'SocialGraph contract is not configured',
      );
    }
    if (this.cachedContract) {
      return this.cachedContract;
    }
    this.cachedContract = await Contract.initialize({
      ...this.aeSdkService.sdk.getContext(),
      aci: loadSocialContractAci(),
      address: this.contractAddress as Encoded.ContractAddress,
    });
    return this.cachedContract;
  }
}
