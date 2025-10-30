import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { TX_FUNCTIONS } from '@/configs';
import { MdwPlugin, Tx } from '@/mdw-sync/plugins/mdw-plugin.interface';
import { Encoded } from '@aeternity/aepp-sdk';
import ContractWithMethods, {
  ContractMethodsBase,
} from '@aeternity/aepp-sdk/es/contract/Contract';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import factoryInterface from 'dex-contracts-v2/build/AedexV2Factory.aci.json';
import routerInterface from 'dex-contracts-v2/build/AedexV2Router.aci.json';
import moment from 'moment';
import { Repository } from 'typeorm';
import { DEX_CONTRACTS } from './config/dex-contracts.config';
import { DexToken } from './entities/dex-token.entity';
import { PairTransaction } from './entities/pair-transaction.entity';
import { Pair } from './entities/pair.entity';
import { DexTokenSummaryService } from './services/dex-token-summary.service';
import { DexTokenService } from './services/dex-token.service';
import { PairHistoryService } from './services/pair-history.service';
import { PairSummaryService } from './services/pair-summary.service';
import { PairService } from './services/pair.service';

@Injectable()
export class DexPlugin implements MdwPlugin {
  name = 'dex';
  private readonly logger = new Logger(DexPlugin.name);

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
    private pairService: PairService,
    private dexTokenService: DexTokenService,
    private pairSummaryService: PairSummaryService,
    private pairHistoryService: PairHistoryService,
    private aePricingService: AePricingService,
    private tokenSummaryService: DexTokenSummaryService,
  ) {
    this.initializeContracts();
  }

  private async initializeContracts() {
    try {
      this.routerContract = await this.aeSdkService.sdk.initializeContract({
        aci: routerInterface,
        address: DEX_CONTRACTS.router as Encoded.ContractAddress,
      });
      this.factoryContract = await this.aeSdkService.sdk.initializeContract({
        aci: factoryInterface,
        address: DEX_CONTRACTS.factory as Encoded.ContractAddress,
      });
    } catch (error) {
      this.logger.error('Failed to initialize contracts', error);
    }
  }

  startFromHeight(): number {
    // Start from a reasonable height where DEX contracts were deployed
    return 100000; // Adjust based on your network
  }

  filters() {
    return [
      {
        type: 'contract_call' as const,
        contractIds: [DEX_CONTRACTS.router, DEX_CONTRACTS.factory],
        functions: [
          TX_FUNCTIONS.swap_exact_tokens_for_tokens,
          TX_FUNCTIONS.swap_tokens_for_exact_tokens,
          TX_FUNCTIONS.swap_exact_tokens_for_ae,
          TX_FUNCTIONS.swap_tokens_for_exact_ae,
          TX_FUNCTIONS.swap_exact_ae_for_tokens,
          TX_FUNCTIONS.swap_ae_for_exact_tokens,
          TX_FUNCTIONS.add_liquidity,
          TX_FUNCTIONS.remove_liquidity,
          TX_FUNCTIONS.add_liquidity_ae,
          TX_FUNCTIONS.remove_liquidity_ae,
        ],
      },
    ];
  }

  async onTransactionsSaved(txs: Partial<Tx>[]): Promise<void> {
    for (const tx of txs) {
      try {
        await this.processTransaction(tx);
      } catch (error) {
        this.logger.error(`Failed to process transaction ${tx.tx_hash}`, error);
      }
    }
  }

  async onReorg(rollBackToHeight: number): Promise<void> {
    this.logger.log(
      `DEX plugin handling reorg from height ${rollBackToHeight}`,
    );
    // DEX plugin doesn't need special reorg handling as it uses FK cascade
  }

  private async processTransaction(tx: Partial<Tx>): Promise<void> {
    if (tx.contract_id !== DEX_CONTRACTS.router) {
      return;
    }

    const pairTransaction = await this.saveTransaction(tx);
    if (!pairTransaction) {
      return;
    }

    const pairInfo = await this.pairService.findByAddress(
      pairTransaction.pair.address,
    );
    await this.pairService.pullPairData(pairInfo);
  }

  private async saveTransaction(
    tx: Partial<Tx>,
  ): Promise<PairTransaction | null> {
    if (tx.contract_id !== DEX_CONTRACTS.router) {
      return null;
    }

    const pairInfo = await this.extractPairInfoFromTransaction(tx);
    if (!pairInfo) {
      return null;
    }

    const pair = await this.saveDexPair(pairInfo, tx);
    return await this.saveDexPairTransaction(pair, tx, pairInfo);
  }

  private validateAndConvertVolume(volume: string): number {
    if (!volume || volume === '0' || volume === 'NaN' || volume === 'undefined')
      return 0;

    const bigNumber = new BigNumber(volume);
    if (bigNumber.isNaN() || bigNumber.isLessThanOrEqualTo(0)) return 0;

    return bigNumber.toNumber();
  }

  private async extractPairInfoFromTransaction(tx: Partial<Tx>) {
    let decodedEvents = null;
    try {
      decodedEvents = this.routerContract.$decodeEvents(tx.raw.tx.log);
    } catch (error: any) {
      // Try factory contract
      try {
        decodedEvents = this.factoryContract.$decodeEvents(tx.raw.tx.log);
      } catch (factoryError: any) {
        this.logger.debug('Failed to decode events', factoryError?.message);
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
    const args = tx.raw.tx.arguments;

    if (
      tx.function === TX_FUNCTIONS.swap_exact_tokens_for_tokens ||
      tx.function === TX_FUNCTIONS.swap_tokens_for_exact_tokens ||
      tx.function === TX_FUNCTIONS.swap_exact_tokens_for_ae ||
      tx.function === TX_FUNCTIONS.swap_tokens_for_exact_ae
    ) {
      token0Address = args[2].value[0]?.value;
      token1Address = args[2].value[1]?.value;
    } else if (
      tx.function === TX_FUNCTIONS.swap_exact_ae_for_tokens ||
      tx.function === TX_FUNCTIONS.swap_ae_for_exact_tokens
    ) {
      token0Address = args[1].value[0]?.value;
      token1Address = args[1].value[1]?.value;
    } else if (
      tx.function === TX_FUNCTIONS.add_liquidity ||
      tx.function === TX_FUNCTIONS.remove_liquidity
    ) {
      token0Address = args[0].value;
      token1Address = args[1].value;
    } else if (
      tx.function === TX_FUNCTIONS.add_liquidity_ae ||
      tx.function === TX_FUNCTIONS.remove_liquidity_ae
    ) {
      token0Address = DEX_CONTRACTS.wae;
      token1Address = args[0].value;
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
      const swapped = swapInfoData[2].split('|');
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

    const { fetchJson } = await import('@/utils/common');
    const { ACTIVE_NETWORK } = await import('@/configs');

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
    tx: Partial<Tx>,
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
      created_at: moment(tx.micro_time).toDate(),
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
    tx: Partial<Tx>,
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
    const existingTransaction = await this.dexPairTransactionRepository
      .createQueryBuilder('pairTransaction')
      .where('pairTransaction.tx_hash = :tx_hash', {
        tx_hash: tx.tx_hash,
      })
      .getOne();

    if (existingTransaction) {
      return existingTransaction;
    }

    return this.dexPairTransactionRepository.save({
      pair: pair,
      account_address: tx.caller_id,
      tx_type: tx.function,
      tx_hash: tx.tx_hash,
      block_height: tx.block_height,
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
      created_at: moment(tx.micro_time).toDate(),
    });
  }
}
