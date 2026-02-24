import camelcaseKeysDeep from 'camelcase-keys-deep';

import { AeSdkService } from '@/ae/ae-sdk.service';
import { ACTIVE_NETWORK, TX_FUNCTIONS } from '@/configs';
import { IMiddlewareRequestConfig } from '@/social/interfaces/post.interfaces';
import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { Contract } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import moment from 'moment';
import { Repository } from 'typeorm';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';
import { DexToken } from '../entities/dex-token.entity';
import { PairTransaction } from '../entities/pair-transaction.entity';
import { Pair } from '../entities/pair.entity';
import { PairService } from './pair.service';
import BigNumber from 'bignumber.js';
import { DexTokenService } from './dex-token.service';
import { PairSummaryService } from './pair-summary.service';
import { PairHistoryService } from './pair-history.service';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { DexTokenSummaryService } from './dex-token-summary.service';

type ContractInstance = Awaited<ReturnType<typeof Contract.initialize>>;

@Injectable()
export class DexSyncService {
  routerContract: ContractInstance;
  factoryContract: ContractInstance;
  constructor(
    @InjectRepository(DexToken)
    private readonly dexTokenRepository: Repository<DexToken>,
    @InjectRepository(Pair)
    private readonly dexPairRepository: Repository<Pair>,
    @InjectRepository(PairTransaction)
    private readonly dexPairTransactionRepository: Repository<PairTransaction>,

    private aeSdkService: AeSdkService,
    private pairService: PairService,
    private dexTokenService: DexTokenService,
    private pairSummaryService: PairSummaryService,
    private pairHistoryService: PairHistoryService,
    private aePricingService: AePricingService,
    private tokenSummaryService: DexTokenSummaryService,
  ) {
    //
  }

  async onModuleInit(): Promise<void> {
    console.log('========================');
    console.log('==== DexSyncService ====');
    console.log('========================');
    // await this.dexPairTransactionRepository.clear();

    // this.routerContract = await Contract.initialize({
    //   ...this.aeSdkService.sdk.getContext(),
    //   aci: routerInterface,
    //   address: DEX_CONTRACTS.router as Encoded.ContractAddress,
    // });
    // this.factoryContract = await Contract.initialize({
    //   ...this.aeSdkService.sdk.getContext(),
    //   aci: factoryInterface,
    //   address: DEX_CONTRACTS.factory as Encoded.ContractAddress,
    // });
    // this.sync();
  }

  async sync() {
    await this.syncDexTokens();
    await this.syncTokenPrices();
  }

  async handleLiveTransaction(transaction: ITransaction) {
    if (transaction.tx.contractId !== DEX_CONTRACTS.router) {
      return;
    }
    const pairTransaction = await this.saveTransaction(transaction);
    if (!pairTransaction) {
      return;
    }
    if (!pairTransaction.pair?.address) {
      return;
    }
    const pairInfo = await this.pairService.findByAddress(
      pairTransaction.pair.address,
    );
    await this.pairService.pullPairData(pairInfo);
  }

  async syncTokenPrices() {
    const pairs = await this.dexPairRepository
      .createQueryBuilder('pair')
      .leftJoinAndSelect('pair.token0', 'token0')
      .leftJoinAndSelect('pair.token1', 'token1')
      .getMany();
    const tokens = await this.dexTokenRepository.find();
    for (const token of tokens) {
      try {
        const priceAnalysis =
          await this.dexTokenService.getTokenPriceWithLiquidityAnalysis(
            token.address,
            DEX_CONTRACTS.wae,
          );

        if (!priceAnalysis || !priceAnalysis.medianPrice) {
          continue; // Skip tokens without price analysis
        }

        const price_data = await this.aePricingService.getPriceData(
          new BigNumber(priceAnalysis.medianPrice),
        );
        await this.dexTokenRepository.update(token.address, {
          price: price_data,
        });
        await this.tokenSummaryService.createOrUpdateSummary(token.address);
      } catch (error) {
        // Log error but continue processing other tokens
        console.error(`Error syncing token ${token.address}:`, error);
        continue;
      }
    }
    for (const pair of pairs) {
      await this.pairSummaryService.createOrUpdateSummary(pair);
    }
  }

  async syncDexTokens() {
    const config: IMiddlewareRequestConfig = {
      // direction: 'backward',
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
    console.log('DexTokens synced');
  }

  async pullDexPairsFromMdw(url: string) {
    const result = await fetchJson(url);
    const data = result?.data ?? [];
    for (const transaction of camelcaseKeysDeep(data)) {
      if (
        transaction.tx.result !== 'ok' ||
        transaction.tx.return == 'invalid' ||
        !transaction.tx.function
      ) {
        continue;
      }
      await this.saveTransaction(transaction);
    }
    if (result.next) {
      return await this.pullDexPairsFromMdw(
        `${ACTIVE_NETWORK.middlewareUrl}${result.next}`,
      );
    }
    return result;
  }

  async saveTransaction(transaction: ITransaction): Promise<PairTransaction> {
    if (transaction.tx.contractId !== DEX_CONTRACTS.router) {
      return;
    }
    const pairInfo = await this.extractPairInfoFromTransaction(transaction);
    if (!pairInfo) {
      return;
    }

    const pair = await this.saveDexPair(pairInfo, transaction);
    return await this.saveDexPairTransaction(pair, transaction, pairInfo);
  }

  /**
   * Validates and converts volume to proper decimal format
   * @param volume - Volume amount as string
   * @returns Validated volume number
   */
  private validateAndConvertVolume(volume: string): number {
    if (!volume || volume === '0' || volume === 'NaN' || volume === 'undefined')
      return 0;

    const bigNumber = new BigNumber(volume);
    if (bigNumber.isNaN() || bigNumber.isLessThanOrEqualTo(0)) return 0;

    // Ensure volume is in proper decimal format
    return bigNumber.toNumber();
  }

  async extractPairInfoFromTransaction(transaction: ITransaction) {
    // console.log('transaction.tx.function:', transaction.tx.function);
    let decodedEvents = null;
    try {
      decodedEvents = this.routerContract.$decodeEvents(transaction.tx.log, {
        omitUnknown: true,
      });
    } catch (error: any) {
      // console.log('routerContract.$decodeEvents error', error?.message);
    }
    if (!decodedEvents || decodedEvents.length === 0) {
      try {
        decodedEvents = this.factoryContract.$decodeEvents(transaction.tx.log, {
          omitUnknown: true,
        });
        // console.log('factoryContract.$decodeEvents decodedEvents', decodedEvents);
      } catch (error: any) {
        console.log('factoryContract.$decodeEvents error', error?.message);
      }
    }
    if (!decodedEvents || decodedEvents.length === 0) {
      return null;
    }
    const pairAddress = decodedEvents.find(
      (event) => event.contract?.name === 'IAedexV2Pair',
    )?.contract?.address;
    let token0Address = null;
    let token1Address = null;
    const args = transaction.tx.arguments;

    if (
      transaction.tx.function === TX_FUNCTIONS.swap_exact_tokens_for_tokens ||
      transaction.tx.function === TX_FUNCTIONS.swap_tokens_for_exact_tokens ||
      transaction.tx.function === TX_FUNCTIONS.swap_exact_tokens_for_ae ||
      transaction.tx.function === TX_FUNCTIONS.swap_tokens_for_exact_ae
    ) {
      token0Address = args[2].value[0]?.value;
      token1Address = args[2].value[1]?.value;
    } else if (
      transaction.tx.function === TX_FUNCTIONS.swap_exact_ae_for_tokens ||
      transaction.tx.function === TX_FUNCTIONS.swap_ae_for_exact_tokens
    ) {
      token0Address = args[1].value[0]?.value;
      token1Address = args[1].value[1]?.value;
    } else if (
      transaction.tx.function === TX_FUNCTIONS.add_liquidity ||
      transaction.tx.function === TX_FUNCTIONS.remove_liquidity
    ) {
      token0Address = args[0].value;
      token1Address = args[1].value;
    } else if (
      transaction.tx.function === TX_FUNCTIONS.add_liquidity_ae ||
      transaction.tx.function === TX_FUNCTIONS.remove_liquidity_ae
    ) {
      // this mean add new pair WAE -> Token
      token0Address = DEX_CONTRACTS.wae;
      token1Address = args[0].value;
    } else {
      // if (transaction.tx.function?.includes('liquidity')) {
      //   return null;
      // }
      console.log('TODO: handle->function:', transaction.tx.function);
      console.log('decodedEvents:', decodedEvents);
      console.log('args::', JSON.stringify(args, null, 2));
    }
    if (!token0Address || !token1Address) {
      return null;
    }

    let volume0 = 0;
    let volume1 = 0;
    let swapInfo = null;
    const swapInfoData = decodedEvents.find(
      (event) => event.name === 'SwapTokens',
    )?.args;
    if (swapInfoData) {
      // console.log('swapInfoData::', swapInfoData);
      const swapped = swapInfoData[2].split('|');
      swapInfo = {
        amount0In: swapped[0],
        amount1In: swapped[1],
        amount0Out: swapped[2],
        amount1Out: swapped[3],
        to: swapped[4],
      };

      // FIXED: Count total money movement in both directions for accurate volume
      // Sum both input and output amounts to get true trading volume
      const totalVolume0 = new BigNumber(swapInfo.amount0In || '0')
        .plus(swapInfo.amount0Out || '0')
        .toString();
      const totalVolume1 = new BigNumber(swapInfo.amount1In || '0')
        .plus(swapInfo.amount1Out || '0')
        .toString();

      volume0 = this.validateAndConvertVolume(totalVolume0);
      volume1 = this.validateAndConvertVolume(totalVolume1);
    }

    let reserve0,
      reserve1 = 0;

    const syncInfoData = decodedEvents.find(
      (event) => event.name === 'Sync',
    )?.args;
    if (syncInfoData) {
      reserve0 = syncInfoData[0]?.toString();
      reserve1 = syncInfoData[1]?.toString();
    }

    let pairMintInfo = null;
    const pairMintInfoData = decodedEvents.find(
      (event) => event.name === 'PairMint',
    )?.args;
    if (pairMintInfoData) {
      pairMintInfo = {
        type: 'PairMint',
        amount0: pairMintInfoData[1]?.toString(),
        amount1: pairMintInfoData[2]?.toString(),
      };
      // FIXED: Don't count liquidity operations as volume - these are not trading activities
      volume0 = this.validateAndConvertVolume('0');
      volume1 = this.validateAndConvertVolume('0');
    }

    const pairBurnInfoData = decodedEvents.find(
      (event) => event.name === 'PairBurn',
    )?.args;
    if (pairBurnInfoData) {
      const args = pairBurnInfoData[2].split('|');
      pairMintInfo = {
        type: 'PairBurn',
        amount0: args[0]?.toString(),
        amount1: args[1]?.toString(),
      };
    }

    const token0 = await this.getOrCreateToken(token0Address);
    const token1 = await this.getOrCreateToken(token1Address);

    return {
      pairAddress,
      token0,
      token1,
      swapInfo,
      reserve0,
      reserve1,
      volume0,
      volume1,
      pairMintInfo,
    };
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
      is_ae: tokenData.address === DEX_CONTRACTS.wae,
    });
  }

  private async saveDexPair(
    pairInfo: {
      pairAddress: string;
      token0: DexToken;
      token1: DexToken;
    },
    transaction: ITransaction,
  ) {
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
      created_at: moment(transaction.microTime).toDate(),
    });
    await this.pairService.pullPairData(pair);
    await Promise.all([
      this.updateTokenPairsCount(pairInfo.token0),
      this.updateTokenPairsCount(pairInfo.token1),
    ]);
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

  private async saveDexPairTransaction(
    pair: Pair,
    transaction: ITransaction,
    pairInfo: {
      pairAddress: string;
      reserve0: number;
      reserve1: number;
      token0: DexToken;
      token1: DexToken;
      volume0: number;
      volume1: number;
      swapInfo: any;
      pairMintInfo: any;
    },
  ): Promise<PairTransaction> {
    await this.dexPairTransactionRepository.upsert(
      {
        pair: pair,
        account_address: transaction.tx.callerId,
        tx_type: transaction.tx.function,
        tx_hash: transaction.hash,
        block_height: transaction.blockHeight,
        reserve0: pairInfo.reserve0,
        reserve1: pairInfo.reserve1,
        total_supply: new BigNumber(pairInfo.reserve0)
          .plus(pairInfo.reserve1)
          .toNumber(),
        ratio0: new BigNumber(pairInfo.reserve0)
          .div(pairInfo.reserve1)
          .toNumber(),
        ratio1: new BigNumber(pairInfo.reserve1)
          .div(pairInfo.reserve0)
          .toNumber(),
        volume0: pairInfo.volume0,
        volume1: pairInfo.volume1,
        swap_info: pairInfo.swapInfo,
        pair_mint_info: pairInfo.pairMintInfo,
        created_at: moment(transaction.microTime).toDate(),
      },
      {
        conflictPaths: ['tx_hash'],
      },
    );

    const savedTransaction = await this.dexPairTransactionRepository.findOne({
      where: { tx_hash: transaction.hash },
      relations: {
        pair: true,
      },
    });

    if (!savedTransaction) {
      throw new Error(
        `Failed to create or retrieve transaction ${transaction.hash}`,
      );
    }

    return savedTransaction;
  }
}
