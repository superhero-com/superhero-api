import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { SyncDirection, SyncDirectionEnum } from '../../plugin.interface';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { ACTIVE_NETWORK, TX_FUNCTIONS } from '@/configs';
import { Encoded } from '@aeternity/aepp-sdk';
import ContractWithMethods, {
  ContractMethodsBase,
} from '@aeternity/aepp-sdk/es/contract/Contract';
import factoryInterface from 'dex-contracts-v2/build/AedexV2Factory.aci.json';
import routerInterface from 'dex-contracts-v2/build/AedexV2Router.aci.json';
import moment from 'moment';
import BigNumber from 'bignumber.js';
import { fetchJson } from '@/utils/common';
import { DEX_CONTRACTS } from '@/dex/config/dex-contracts.config';
import { DexToken } from '@/dex/entities/dex-token.entity';
import { PairTransaction } from '@/dex/entities/pair-transaction.entity';
import { Pair } from '@/dex/entities/pair.entity';
import { PairService } from '@/dex/services/pair.service';

interface PairInfo {
  pairAddress: string;
  token0: DexToken;
  token1: DexToken;
  swapInfo: any;
  reserve0: string;
  reserve1: string;
  volume0: number;
  volume1: number;
  pairMintInfo: any;
}

@Injectable()
export class DexTransactionProcessorService {
  private readonly logger = new Logger(DexTransactionProcessorService.name);
  private routerContract: ContractWithMethods<ContractMethodsBase> | null = null;
  private factoryContract: ContractWithMethods<ContractMethodsBase> | null = null;

  constructor(
    @InjectRepository(DexToken)
    private readonly dexTokenRepository: Repository<DexToken>,
    @InjectRepository(Pair)
    private readonly dexPairRepository: Repository<Pair>,
    @InjectRepository(PairTransaction)
    private readonly dexPairTransactionRepository: Repository<PairTransaction>,
    private readonly aeSdkService: AeSdkService,
    private readonly pairService: PairService,
  ) {}

  /**
   * Initialize contracts lazily
   */
  private async ensureContractsInitialized(): Promise<void> {
    if (!this.routerContract) {
      this.routerContract = await this.aeSdkService.sdk.initializeContract({
        aci: routerInterface,
        address: DEX_CONTRACTS.router as Encoded.ContractAddress,
      });
    }
    if (!this.factoryContract) {
      this.factoryContract = await this.aeSdkService.sdk.initializeContract({
        aci: factoryInterface,
        address: DEX_CONTRACTS.factory as Encoded.ContractAddress,
      });
    }
  }

  /**
   * Process a DEX transaction
   * @param tx - Transaction entity from MDW sync
   * @param syncDirection - Sync direction (backward/live/reorg)
   * @returns PairTransaction if processed successfully, null otherwise
   */
  async processTransaction(
    tx: Tx,
    syncDirection: SyncDirection,
  ): Promise<PairTransaction | null> {
    try {
      // Check if this is a DEX router transaction
      if (tx.contract_id !== DEX_CONTRACTS.router) {
        console.log('[dex] not a DEX router transaction', tx);
        return null;
      }

      // Extract pair info from transaction
      const pairInfo = await this.extractPairInfoFromTransaction(tx);
      if (!pairInfo) {
        return null;
      }

      // Wrap operations in a transaction for consistency
      return await this.dexPairTransactionRepository.manager.transaction(
        async (manager) => {
          const pair = await this.saveDexPair(pairInfo, tx, manager);
          return await this.saveDexPairTransaction(
            pair,
            pairInfo,
            tx,
            manager,
          );
        },
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to process DEX transaction ${tx.hash}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Validates and converts volume to proper decimal format
   */
  private validateAndConvertVolume(volume: string): number {
    if (!volume || volume === '0' || volume === 'NaN' || volume === 'undefined')
      return 0;

    const bigNumber = new BigNumber(volume);
    if (bigNumber.isNaN() || bigNumber.isLessThanOrEqualTo(0)) return 0;

    return bigNumber.toNumber();
  }

  /**
   * Extract pair information from transaction
   */
  private async extractPairInfoFromTransaction(
    tx: Tx,
  ): Promise<PairInfo | null> {
    // Ensure contracts are initialized
    await this.ensureContractsInitialized();


    let decodedEvents = null;
    try {
      if (this.routerContract) {
        decodedEvents = this.routerContract.$decodeEvents(tx.raw.log, {
          omitUnknown: true,
        });
      }
    } catch (error: any) {
      // Try factory contract if router fails
    }

    if (!decodedEvents) {
      try {
        if (this.factoryContract) {
          decodedEvents = this.factoryContract.$decodeEvents(tx.raw.log, {
            omitUnknown: true,
          });
        }
      } catch (error: any) {
        this.logger.debug(
          `Failed to decode events for transaction ${tx.hash}`,
        );
      }
    }

    if (!decodedEvents) {
      return null;
    }

    const pairAddress = decodedEvents.find(
      (event) => event.contract?.name === 'IAedexV2Pair',
    )?.contract?.address;

    if (!pairAddress) {
      return null;
    }

    let token0Address: string | null = null;
    let token1Address: string | null = null;
    const args = tx.raw.arguments;
    const txFunction = tx.function;

    // Extract token addresses based on function type
    if (
      txFunction === TX_FUNCTIONS.swap_exact_tokens_for_tokens ||
      txFunction === TX_FUNCTIONS.swap_tokens_for_exact_tokens ||
      txFunction === TX_FUNCTIONS.swap_exact_tokens_for_ae ||
      txFunction === TX_FUNCTIONS.swap_tokens_for_exact_ae
    ) {
      token0Address = args[2]?.value?.[0]?.value;
      token1Address = args[2]?.value?.[1]?.value;
    } else if (
      txFunction === TX_FUNCTIONS.swap_exact_ae_for_tokens ||
      txFunction === TX_FUNCTIONS.swap_ae_for_exact_tokens
    ) {
      token0Address = args[1]?.value?.[0]?.value;
      token1Address = args[1]?.value?.[1]?.value;
    } else if (
      txFunction === TX_FUNCTIONS.add_liquidity ||
      txFunction === TX_FUNCTIONS.remove_liquidity
    ) {
      token0Address = args[0]?.value;
      token1Address = args[1]?.value;
    } else if (
      txFunction === TX_FUNCTIONS.add_liquidity_ae ||
      txFunction === TX_FUNCTIONS.remove_liquidity_ae
    ) {
      token0Address = DEX_CONTRACTS.wae;
      token1Address = args[0]?.value;
    } else {
      this.logger.debug(
        `Unhandled DEX function: ${txFunction} for tx ${tx.hash}`,
      );
      return null;
    }

    if (!token0Address || !token1Address) {
      return null;
    }

    // Extract swap info
    let volume0 = 0;
    let volume1 = 0;
    let swapInfo = null;
    const swapInfoData = decodedEvents.find(
      (event) => event.name === 'SwapTokens',
    )?.args;

    if (swapInfoData) {
      const swapped = swapInfoData[2]?.split('|');
      swapInfo = {
        amount0In: swapped[0],
        amount1In: swapped[1],
        amount0Out: swapped[2],
        amount1Out: swapped[3],
        to: swapped[4],
      };

      const totalVolume0 = new BigNumber(swapInfo.amount0In || '0')
        .plus(swapInfo.amount0Out || '0')
        .toString();
      const totalVolume1 = new BigNumber(swapInfo.amount1In || '0')
        .plus(swapInfo.amount1Out || '0')
        .toString();

      volume0 = this.validateAndConvertVolume(totalVolume0);
      volume1 = this.validateAndConvertVolume(totalVolume1);
    }

    // Extract reserves
    let reserve0 = '0';
    let reserve1 = '0';
    const syncInfoData = decodedEvents.find(
      (event) => event.name === 'Sync',
    )?.args;

    if (syncInfoData) {
      reserve0 = syncInfoData[0]?.toString() || '0';
      reserve1 = syncInfoData[1]?.toString() || '0';
    }

    // Extract liquidity info
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
      // Don't count liquidity operations as volume
      volume0 = 0;
      volume1 = 0;
    }

    const pairBurnInfoData = decodedEvents.find(
      (event) => event.name === 'PairBurn',
    )?.args;

    if (pairBurnInfoData) {
      const args = pairBurnInfoData[2]?.split('|');
      pairMintInfo = {
        type: 'PairBurn',
        amount0: args[0]?.toString(),
        amount1: args[1]?.toString(),
      };
      volume0 = 0;
      volume1 = 0;
    }

    // Get or create tokens
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

  /**
   * Get or create a DEX token
   */
  private async getOrCreateToken(address: string): Promise<DexToken> {
    let token = await this.dexTokenRepository.findOne({
      where: { address },
    });

    if (token) {
      return token;
    }

    try {
      const tokenData = await fetchJson(
        `${ACTIVE_NETWORK.middlewareUrl}/v3/aex9/${address}`,
      );

      token = await this.dexTokenRepository.save({
        address,
        name: tokenData.name,
        symbol: tokenData.symbol,
        decimals: tokenData.decimals,
        is_ae: tokenData.address === DEX_CONTRACTS.wae,
      });
    } catch (error) {
      this.logger.error(`Failed to fetch token data for ${address}`, error);
      // Create a basic token entry if fetch fails
      token = await this.dexTokenRepository.save({
        address,
        name: 'Unknown',
        symbol: 'UNK',
        decimals: 18,
        is_ae: address === DEX_CONTRACTS.wae,
      });
    }

    return token;
  }

  /**
   * Save or get existing DEX pair
   */
  private async saveDexPair(
    pairInfo: PairInfo,
    tx: Tx,
    manager: EntityManager,
  ): Promise<Pair> {
    const pairRepository = manager.getRepository(Pair);
    let pair = await pairRepository.findOne({
      where: { address: pairInfo.pairAddress },
    });

    if (pair) {
      return pair;
    }

    const microTime = parseInt(tx.micro_time, 10);
    pair = await pairRepository.save({
      address: pairInfo.pairAddress,
      token0: pairInfo.token0,
      token1: pairInfo.token1,
      created_at: moment(microTime).toDate(),
    });

    // Pull pair data asynchronously (outside transaction)
    this.pairService.pullPairData(pair).catch((error) => {
      this.logger.error(
        `Failed to pull pair data for ${pair.address}`,
        error,
      );
    });

    // Update token pairs count
    await Promise.all([
      this.updateTokenPairsCount(pairInfo.token0, manager),
      this.updateTokenPairsCount(pairInfo.token1, manager),
    ]);

    return pair;
  }

  /**
   * Update token pairs count
   */
  private async updateTokenPairsCount(
    token: DexToken,
    manager: EntityManager,
  ): Promise<void> {
    const pairRepository = manager.getRepository(Pair);
    const pairsCount = await pairRepository
      .createQueryBuilder('pair')
      .where('pair.token0_address = :token0_address', {
        token0_address: token.address,
      })
      .orWhere('pair.token1_address = :token1_address', {
        token1_address: token.address,
      })
      .getCount();

    await manager.getRepository(DexToken).update(token.address, {
      pairs_count: pairsCount,
    });
  }

  /**
   * Save DEX pair transaction
   */
  private async saveDexPairTransaction(
    pair: Pair,
    pairInfo: PairInfo,
    tx: Tx,
    manager: EntityManager,
  ): Promise<PairTransaction> {
    const pairTransactionRepository = manager.getRepository(PairTransaction);

    // Check if transaction already exists
    const existingTransaction = await pairTransactionRepository.findOne({
      where: { tx_hash: tx.hash },
    });

    if (existingTransaction) {
      return existingTransaction;
    }

    const reserve0Num = new BigNumber(pairInfo.reserve0 || '0').toNumber();
    const reserve1Num = new BigNumber(pairInfo.reserve1 || '0').toNumber();
    const microTime = parseInt(tx.micro_time, 10);

    return await pairTransactionRepository.save({
      pair: pair,
      account_address: tx.caller_id || null,
      tx_type: tx.function || '',
      tx_hash: tx.hash,
      block_height: tx.block_height,
      reserve0: reserve0Num,
      reserve1: reserve1Num,
      total_supply: new BigNumber(reserve0Num).plus(reserve1Num).toNumber(),
      ratio0:
        reserve1Num > 0
          ? new BigNumber(reserve0Num).div(reserve1Num).toNumber()
          : 0,
      ratio1:
        reserve0Num > 0
          ? new BigNumber(reserve1Num).div(reserve0Num).toNumber()
          : 0,
      volume0: pairInfo.volume0,
      volume1: pairInfo.volume1,
      swap_info: pairInfo.swapInfo,
      pair_mint_info: pairInfo.pairMintInfo,
      created_at: moment(microTime).toDate(),
    });
  }
}

