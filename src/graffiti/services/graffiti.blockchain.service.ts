import { Injectable } from '@nestjs/common';
import { AeSdk, Node } from '@aeternity/aepp-sdk';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const contractAci = require('../GraffitiAuctionACI.json');

@Injectable()
export class GraffitiBlockchainService {
  private client: AeSdk | null = null;
  private contract: any | null = null;

  private async ensureClient() {
    if (this.client && this.contract) return;
    if (!process.env.CONTRACT_ADDRESS)
      throw new Error('CONTRACT_ADDRESS is not set');
    if (!process.env.NODE_URL) throw new Error('NODE_URL is not set');
    this.client = new AeSdk({
      nodes: [{ name: 'node', instance: new Node(process.env.NODE_URL) }],
    });
    this.contract = await this.client.initializeContract({
      aci: contractAci,
      address: process.env.CONTRACT_ADDRESS as any,
    });
  }

  async height() {
    await this.ensureClient();
    return await this.client!.getHeight();
  }

  async auctionSlots() {
    await this.ensureClient();
    const res = await this.contract!.all_auction_slots();
    return res.decodedResult;
  }
}
