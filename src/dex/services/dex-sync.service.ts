import camelcaseKeysDeep from 'camelcase-keys-deep';

import { AeSdkService } from '@/ae/ae-sdk.service';
import { ACTIVE_NETWORK, TX_FUNCTIONS } from '@/configs';
import { IMiddlewareRequestConfig } from '@/social/interfaces/post.interfaces';
import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { Encoded } from '@aeternity/aepp-sdk';
import ContractWithMethods, {
  ContractMethodsBase,
} from '@aeternity/aepp-sdk/es/contract/Contract';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import factoryInterface from 'dex-contracts-v2/build/AedexV2Factory.aci.json';
import routerInterface from 'dex-contracts-v2/build/AedexV2Router.aci.json';
import { Repository } from 'typeorm';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';
import { DexToken } from '../entities/dex-token.entity';
import { Pair } from '../entities/pair.entity';
import { PairTransaction } from '../entities/pair-transaction.entity';
import moment from 'moment';

@Injectable()
export class DexSyncService {
  routerContract: ContractWithMethods<ContractMethodsBase>;
  factoryContract: ContractWithMethods<ContractMethodsBase>;
  constructor(
    @InjectRepository(DexToken)
    private readonly dexTokenRepository: Repository<DexToken>,
    @InjectRepository(Pair)
    private readonly dexPairRepository: Repository<Pair>,
    @InjectRepository(PairTransaction)
    private readonly dexPairTransactionRepository: Repository<PairTransaction>,

    private aeSdkService: AeSdkService,
  ) {
    //
  }

  async onModuleInit(): Promise<void> {
    console.log('========================');
    console.log('==== DexSyncService ====');
    console.log('========================');
    //
    return;

    this.routerContract = await this.aeSdkService.sdk.initializeContract({
      aci: routerInterface,
      address: DEX_CONTRACTS.router as Encoded.ContractAddress,
    });
    this.factoryContract = await this.aeSdkService.sdk.initializeContract({
      aci: factoryInterface,
      address: DEX_CONTRACTS.factory as Encoded.ContractAddress,
    });
    this.syncDexTokens();
  }

  async syncDexTokens() {
    const config: IMiddlewareRequestConfig = {
      direction: 'forward',
      limit: 100,
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
    const result = await fetchJson(url);
    const data = result?.data ?? [];
    for (const item of camelcaseKeysDeep(data)) {
      if (
        item.tx.result !== 'ok' ||
        item.tx.return == 'invalid' ||
        !item.tx.function
      ) {
        continue;
      }
      // console.log('--------------------------------');
      const pairInfo = await this.extractPairInfoFromTransaction(item);
      if (!pairInfo) {
        // console.log('pairInfo', pairInfo);
        continue;
      }
      // console.log('pairInfo', pairInfo.pairAddress);
      // console.log('--------------------------------');

      const pair = await this.saveDexPair(pairInfo);
      await this.saveDexPairTransaction(pair, item);
    }
    if (result.next) {
      return await this.pullDexPairsFromMdw(
        `${ACTIVE_NETWORK.middlewareUrl}${result.next}`,
      );
    }
    return result;
  }

  async extractPairInfoFromTransaction(item: ITransaction) {
    console.log('item.tx.function:', item.tx.function);
    let decodedEvents = null;
    try {
      decodedEvents = this.routerContract.$decodeEvents(item.tx.log);
    } catch (error: any) {
      console.log('routerContract.$decodeEvents error', error?.message);
    }
    if (!decodedEvents) {
      try {
        decodedEvents = this.factoryContract.$decodeEvents(item.tx.log);
        // console.log('factoryContract.$decodeEvents decodedEvents', decodedEvents);
      } catch (error: any) {
        console.log('factoryContract.$decodeEvents error', error?.message);
      }
    }
    if (!decodedEvents) {
      return null;
    }
    const pairAddress = decodedEvents.find(
      (event) => event.contract?.name === 'IAedexV2Pair',
    )?.contract?.address;
    let token0Address = null;
    let token1Address = null;
    const args = item.tx.arguments;

    if (
      item.tx.function === TX_FUNCTIONS.swap_exact_tokens_for_tokens ||
      item.tx.function === TX_FUNCTIONS.swap_tokens_for_exact_tokens ||
      item.tx.function === TX_FUNCTIONS.swap_exact_tokens_for_ae ||
      item.tx.function === TX_FUNCTIONS.swap_tokens_for_exact_ae
    ) {
      token0Address = args[2].value[0]?.value;
      token1Address = args[2].value[1]?.value;
    } else if (
      item.tx.function === TX_FUNCTIONS.swap_exact_ae_for_tokens ||
      item.tx.function === TX_FUNCTIONS.swap_ae_for_exact_tokens
    ) {
      token0Address = args[1].value[0]?.value;
      token1Address = args[1].value[1]?.value;
    } else if (item.tx.function === TX_FUNCTIONS.add_liquidity) {
      token0Address = args[0].value;
      token1Address = args[1].value;
      // console.log('args::', JSON.stringify(args, null, 2));
    } else if (item.tx.function === TX_FUNCTIONS.add_liquidity_ae) {
      // this mean add new pair WAE -> Token
      token0Address = DEX_CONTRACTS.wae;
      token1Address = args[0].value;
    } else {
      // if (item.tx.function?.includes('liquidity')) {
      //   return null;
      // }
      // console.log('item.tx.function:', item.tx.function);
      // console.log('args::', JSON.stringify(args, null, 2));
    }
    if (!token0Address || !token1Address) {
      return null;
    }

    const token0 = await this.getOrCreateToken(token0Address);
    const token1 = await this.getOrCreateToken(token1Address);

    return { pairAddress, token0, token1 };
  }

  private async getOrCreateToken(address: string) {
    const token = await this.dexTokenRepository.findOne({
      where: { address },
    });
    if (token) {
      return token;
    }
    const tokenData = await fetchJson(
      `${ACTIVE_NETWORK.middlewareUrl}/v3/aex9/${address}`,
    );
    return this.dexTokenRepository.save({
      address,
      name: tokenData.name,
      symbol: tokenData.symbol,
      decimals: tokenData.decimals,
    });
  }

  private async saveDexPair(pairInfo: {
    pairAddress: string;
    token0: DexToken;
    token1: DexToken;
  }) {
    let pair = await this.dexPairRepository.findOne({
      where: { address: pairInfo.pairAddress },
    });
    if (pair) {
      return pair;
    }

    pair = await this.dexPairRepository.save({
      address: pairInfo.pairAddress,
      token0: pairInfo.token0,
      token1: pairInfo.token1,
    });
    await this.updateTokenPairsCount(pairInfo.token0);
    await this.updateTokenPairsCount(pairInfo.token1);
    return pair;
  }

  private async updateTokenPairsCount(token: DexToken) {
    const pairsCount = await this.dexPairRepository
      .createQueryBuilder('pair')
      .where('pair.token0_address = :token0_address', {
        token0_address: token.address,
      })
      .orWhere('pair.token1_address = :token1_address', {
        token1_address: token.address,
      })
      .getCount();
    await this.dexTokenRepository.update(token.address, {
      pairs_count: pairsCount,
    });
  }

  private async saveDexPairTransaction(pair: Pair, item: ITransaction) {
    const existingTransaction = await this.dexPairTransactionRepository
      .createQueryBuilder('pairTransaction')
      .where('pairTransaction.tx_hash = :tx_hash', {
        tx_hash: item.hash,
      })
      .getOne();
    if (existingTransaction) {
      await this.dexPairTransactionRepository.update(
        existingTransaction.tx_hash,
        {
          pair: pair,
          tx_type: item.tx.function,
          tx_hash: item.hash,
          created_at: moment(item.microTime).toDate(),
        },
      );
      return existingTransaction;
    }
    await this.dexPairTransactionRepository.save({
      pair: pair,
      tx_type: item.tx.function,
      tx_hash: item.hash,
      created_at: moment(item.microTime).toDate(),
    });
  }
}
