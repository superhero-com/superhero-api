import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Encoded } from '@aeternity/aepp-sdk';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { SocialGraphV2Reader } from './social-graph-v2-reader';

@Injectable()
export class SocialGraphV2Service {
  private reader?: SocialGraphV2Reader;
  constructor(private readonly ae: AeSdkService) {}

  getReader(): SocialGraphV2Reader {
    if (this.reader) return this.reader;
    const contract = process.env.SOCIAL_GRAPH_V2_CONTRACT_ADDRESS;
    const network = process.env.SOCIAL_GRAPH_V2_NETWORK_ID;
    if (!contract || !network)
      throw new ServiceUnavailableException(
        'V2 social graph is not configured',
      );
    if (!/^ct_[1-9A-HJ-NP-Za-km-z]+$/.test(contract))
      throw new ServiceUnavailableException(
        'Invalid V2 contract configuration',
      );
    this.reader = new SocialGraphV2Reader(this.ae.sdk.getContext().onNode, {
      contract: contract as Encoded.ContractAddress,
      network,
    });
    return this.reader;
  }
}
