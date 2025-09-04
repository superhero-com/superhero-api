import { AeSdkService } from '@/ae/ae-sdk.service';
import { ACTIVE_NETWORK } from '@/configs';
import { IMiddlewareRequestConfig } from '@/social/interfaces/post.interfaces';
import { fetchJson } from '@/utils/common';
import ContractWithMethods, {
  ContractMethodsBase,
} from '@aeternity/aepp-sdk/es/contract/Contract';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as routerInterface from 'dex-contracts-v2/build/AedexV2Router.aci.json';
import { Repository } from 'typeorm';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';
import { DexToken } from '../entities/dex-token.entity';
import { Pair } from '../entities/pair.entity';
import { Encoded } from '@aeternity/aepp-sdk';

@Injectable()
export class DexSyncService {
  routerContract: ContractWithMethods<ContractMethodsBase>;
  constructor(
    @InjectRepository(DexToken)
    private readonly dexTokenRepository: Repository<DexToken>,
    @InjectRepository(Pair)
    private readonly dexPairRepository: Repository<Pair>,

    private aeSdkService: AeSdkService,
  ) {
    //
  }

  async onModuleInit(): Promise<void> {
    console.log('========================');
    console.log('======DexSyncService==================');
    console.log('========================');
    //

    this.routerContract = await this.aeSdkService.sdk.initializeContract({
      aci: routerInterface,
      address: DEX_CONTRACTS.router as Encoded.ContractAddress,
    });
    this.syncDexTokens();
  }

  async syncDexTokens() {
    const config: IMiddlewareRequestConfig = {
      direction: 'forward',
      limit: 10,
      type: 'contract_call',
      contract: DEX_CONTRACTS.router,
    };
    const queryString = new URLSearchParams({
      direction: config.direction,
      limit: config.limit.toString(),
      type: config.type,
      contract: config.contract,
    }).toString();
    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${queryString}`;
    await this.pullDexPairsFromMdw(url);
  }

  async pullDexPairsFromMdw(url: string) {
    console.log('========================');
    const result = await fetchJson(url);
    const data = result?.data ?? [];
    for (const item of data) {
      if (item.tx.function === 'add_liquidity') {
        console.log('========================');
        console.log('item', item);
        console.log('logs', item.tx.log);
        console.log('routerInterface', routerInterface);
        console.log('this.routerContrac', this.routerContract);
        console.log('========================');
        const decodedEvents = this.routerContract.$decodeEvents(item.tx.log);
        console.log('decodedEvents', decodedEvents);

        break;
      }

      // await this.saveDexPairFromTransaction(camelcaseKeysDeep(item));
    }
    // if (result.next) {
    //   return await this.pullDexPairsFromMdw(
    //     `${ACTIVE_NETWORK.middlewareUrl}${result.next}`,
    //   );
    // }
    return result;
  }
}
