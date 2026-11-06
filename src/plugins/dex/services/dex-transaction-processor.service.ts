import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { SyncDirection } from '../../plugin.interface';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { ACTIVE_NETWORK, TX_FUNCTIONS } from '@/configs';
import { Contract, Encoded } from '@aeternity/aepp-sdk';
import routerInterface from 'dex-contracts-v2/build/AedexV2Router.aci.json';
import moment from 'moment';
import BigNumber from 'bignumber.js';
import {
  fetchJson,
  FetchJsonHttpError,
  normalizeEventTopics,
  sanitizeJsonForPostgres,
} from '@/utils/common';
import { DEX_CONTRACTS } from '@/dex/config/dex-contracts.config';
import { DexToken } from '@/dex/entities/dex-token.entity';
import { PairTransaction } from '@/dex/entities/pair-transaction.entity';
import { Pair } from '@/dex/entities/pair.entity';
import { PairService } from '@/dex/services/pair.service';
import { DexTokenSummaryService } from '@/dex/services/dex-token-summary.service';

interface PairInfo {
  pairAddress: string;
  token0: DexToken;
  token1: DexToken;
  swapInfo: any;
  reserve0: string;
  reserve1: string;
  // Raw on-chain amounts kept as decimal strings to preserve full precision
  // (they exceed Number.MAX_SAFE_INTEGER).
  volume0: string;
  volume1: string;
  pairMintInfo: any;
}

type ContractInstance = Awaited<ReturnType<typeof Contract.initialize>>;

@Injectable()
export class DexTransactionProcessorService {
  private readonly logger = new Logger(DexTransactionProcessorService.name);
  private routerContract: ContractInstance | null = null;

  constructor(
    @InjectRepository(DexToken)
    private readonly dexTokenRepository: Repository<DexToken>,
    @InjectRepository(Pair)
    private readonly dexPairRepository: Repository<Pair>,
    @InjectRepository(PairTransaction)
    private readonly dexPairTransactionRepository: Repository<PairTransaction>,
    private readonly aeSdkService: AeSdkService,
    private readonly pairService: PairService,
    private readonly dexTokenSummaryService: DexTokenSummaryService,
  ) {}

  /**
   * Remove pair_transactions for transactions that were rolled back by a reorg
   * (or flagged invalid), and recompute the summaries that counted them.
   *
   * pair_transactions has no FK to the `tx` table — only a CASCADE to `pairs` —
   * so deleting the underlying `tx` rows does NOT clean these up. Without this,
   * a reorged-out swap stays in the table forever and every downstream
   * aggregate (OHLC candles, volume, token summaries) keeps counting a
   * transaction that no longer exists on-chain, while its canonical replacement
   * is also inserted — double-counting it.
   *
   * @returns number of pair_transactions rows removed
   */
  async removeByTxHashes(txHashes: string[]): Promise<number> {
    if (!txHashes || txHashes.length === 0) {
      return 0;
    }

    // Collect the tokens whose summaries counted these transactions BEFORE the
    // rows are deleted, so we can recompute them afterwards.
    const affectedRows = await this.dexPairTransactionRepository
      .createQueryBuilder('pt')
      .leftJoin('pt.pair', 'pair')
      .select('pair.token0_address', 'token0_address')
      .addSelect('pair.token1_address', 'token1_address')
      .where('pt.tx_hash IN (:...txHashes)', { txHashes })
      .getRawMany<{ token0_address: string; token1_address: string }>();

    const result = await this.dexPairTransactionRepository.delete({
      tx_hash: In(txHashes),
    });
    const removed = result.affected ?? 0;

    if (removed === 0) {
      return 0;
    }

    const affectedTokens = new Set<string>();
    for (const row of affectedRows) {
      if (row.token0_address) affectedTokens.add(row.token0_address);
      if (row.token1_address) affectedTokens.add(row.token1_address);
    }

    // Recompute each affected token summary so derived volume/price/change do
    // not keep reflecting the removed transactions until the next sync tick.
    for (const tokenAddress of affectedTokens) {
      try {
        await this.dexTokenSummaryService.createOrUpdateSummary(tokenAddress);
      } catch (error: any) {
        this.logger.error(
          `Failed to recompute summary for ${tokenAddress} after reorg`,
          error.stack,
        );
      }
    }

    this.logger.log(
      `Removed ${removed} pair_transactions and recomputed ${affectedTokens.size} token summaries after reorg`,
    );

    return removed;
  }

  private async getRouterContract(): Promise<ContractInstance> {
    if (!this.routerContract) {
      this.routerContract = await Contract.initialize({
        ...this.aeSdkService.sdk.getContext(),
        aci: routerInterface,
        address: DEX_CONTRACTS.router as Encoded.ContractAddress,
      });
    }
    return this.routerContract;
  }

  /**
   * Process a DEX transaction
   * @param tx - Transaction entity from MDW sync
   * @param syncDirection - Sync direction (backward/live/reorg)
   * @returns PairTransaction if processed, null if the tx is not a DEX trade.
   *   Errors propagate so the batch processor parks the tx for retry.
   */
  async processTransaction(
    tx: Tx,
    syncDirection: SyncDirection,
  ): Promise<PairTransaction | null> {
    void syncDirection;
    // Check if this is a DEX router transaction
    if (tx.contract_id !== DEX_CONTRACTS.router) {
      this.logger.debug(`Skipping non-DEX router transaction ${tx.hash ?? ''}`);
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
        return await this.saveDexPairTransaction(pair, pairInfo, tx, manager);
      },
    );
  }

  /**
   * Validates and converts volume to proper decimal format
   */
  private validateAndConvertVolume(volume: string): string {
    if (!volume || volume === '0' || volume === 'NaN' || volume === 'undefined')
      return '0';

    const bigNumber = new BigNumber(volume);
    if (bigNumber.isNaN() || bigNumber.isLessThanOrEqualTo(0)) return '0';

    // Keep full precision (raw aettos exceed Number.MAX_SAFE_INTEGER).
    return bigNumber.toFixed();
  }

  /**
   * The two tokens of the pair a transaction is recorded under: the last hop
   * of a swap path, or the pair a liquidity call names. Order is the caller's.
   * Nothing in the router runs after the last hop, so that pair's newest events
   * are the router's own; an earlier hop's pair can still be called by a later
   * hop's callback. Stored rows use the last hop too.
   */
  private getRecordedPairTokens(tx: Tx): [string, string] | null {
    const args = tx.raw?.arguments ?? [];
    const lastHop = (path: unknown) =>
      Array.isArray(path) ? [path.at(-2)?.value, path.at(-1)?.value] : [];
    let tokenA: string | undefined;
    let tokenB: string | undefined;
    switch (tx.function) {
      case TX_FUNCTIONS.swap_exact_tokens_for_tokens:
      case TX_FUNCTIONS.swap_tokens_for_exact_tokens:
      case TX_FUNCTIONS.swap_exact_tokens_for_ae:
      case TX_FUNCTIONS.swap_tokens_for_exact_ae:
        [tokenA, tokenB] = lastHop(args[2]?.value);
        break;
      case TX_FUNCTIONS.swap_exact_ae_for_tokens:
      case TX_FUNCTIONS.swap_ae_for_exact_tokens:
        [tokenA, tokenB] = lastHop(args[1]?.value);
        break;
      case TX_FUNCTIONS.add_liquidity:
      case TX_FUNCTIONS.remove_liquidity:
        tokenA = args[0]?.value;
        tokenB = args[1]?.value;
        break;
      case TX_FUNCTIONS.add_liquidity_ae:
      case TX_FUNCTIONS.remove_liquidity_ae:
        tokenA = args[0]?.value;
        tokenB = DEX_CONTRACTS.wae;
        break;
      default:
        this.logger.debug(
          `Unhandled DEX function: ${tx.function} for tx ${tx.hash}`,
        );
        return null;
    }
    return tokenA && tokenB ? [tokenA, tokenB] : null;
  }

  /**
   * Extract pair information from transaction
   */
  private async extractPairInfoFromTransaction(
    tx: Tx,
  ): Promise<PairInfo | null> {
    const log: any[] = tx.raw?.log ?? [];
    // A reverted call has no events and may name a pair that was never created.
    if (log.length === 0) {
      return null;
    }

    const recordedTokens = this.getRecordedPairTokens(tx);
    if (!recordedTokens) {
      return null;
    }

    // Tokens and swap callbacks run inside the same call and can emit events
    // named like the pair's, so only the router's pair is trusted. The log is
    // newest-first, so without this filter a token's event emitted after
    // `pair.burn` would be read as the pair's.
    const pairAddress = await this.pairService.getFactoryPairAddress(
      ...recordedTokens,
    );
    if (!pairAddress) {
      // The call succeeded, so the router found this pair. Throwing parks the
      // tx until the node we ask has caught up.
      throw new Error(
        `Factory has no pair for ${recordedTokens.join('/')} in tx ${tx.hash}`,
      );
    }
    const pairLog = log.filter((entry) => entry?.address === pairAddress);
    if (pairLog.length === 0) {
      this.logger.error(`No events from pair ${pairAddress} in tx ${tx.hash}`);
      return null;
    }

    const routerContract = await this.getRouterContract();
    const decodedEvents: any[] = routerContract.$decodeEvents(
      normalizeEventTopics(pairLog),
      { omitUnknown: true },
    );

    // Extract swap info
    let volume0 = '0';
    let volume1 = '0';
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
      volume0 = '0';
      volume1 = '0';
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
      volume0 = '0';
      volume1 = '0';
    }

    // Reserves and event amounts follow the pair's token order, not the caller's.
    const pairTokens = await this.pairService.getPairTokens(pairAddress);
    const token0 = await this.getOrCreateToken(pairTokens.token0);
    const token1 = await this.getOrCreateToken(pairTokens.token1);

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

      // The deployer picks these, and a NUL byte or a missing value would fail
      // the save on every retry and lose the swap.
      token = await this.dexTokenRepository.save({
        address,
        name: sanitizeJsonForPostgres(tokenData.name) || 'Unknown',
        symbol: sanitizeJsonForPostgres(tokenData.symbol) || 'UNK',
        decimals: tokenData.decimals,
        is_ae: tokenData.address === DEX_CONTRACTS.wae,
      });
    } catch (error) {
      // Nothing repairs the placeholder later, so only settle for it when the
      // middleware says it doesn't know the token. Anything else is transient
      // and the swap is parked for retry.
      if (!(error instanceof FetchJsonHttpError && error.status === 404)) {
        throw error;
      }
      this.logger.error(`Failed to fetch token data for ${address}`, error);
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
      this.logger.error(`Failed to pull pair data for ${pair.address}`, error);
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

    // Raw reserves can exceed Number.MAX_SAFE_INTEGER, so keep everything in
    // BigNumber and store as full-precision decimal strings (the columns are
    // `numeric`). Converting through toNumber() would silently truncate.
    const reserve0Bn = new BigNumber(pairInfo.reserve0 || '0');
    const reserve1Bn = new BigNumber(pairInfo.reserve1 || '0');
    const microTime = parseInt(tx.micro_time, 10);

    await pairTransactionRepository.upsert(
      {
        pair: pair,
        account_address: tx.caller_id || null,
        tx_type: tx.function || '',
        tx_hash: tx.hash,
        block_height: tx.block_height,
        reserve0: reserve0Bn.toFixed(),
        reserve1: reserve1Bn.toFixed(),
        total_supply: reserve0Bn.plus(reserve1Bn).toFixed(),
        ratio0: reserve1Bn.gt(0) ? reserve0Bn.div(reserve1Bn).toFixed() : '0',
        ratio1: reserve0Bn.gt(0) ? reserve1Bn.div(reserve0Bn).toFixed() : '0',
        volume0: pairInfo.volume0,
        volume1: pairInfo.volume1,
        swap_info: pairInfo.swapInfo,
        pair_mint_info: pairInfo.pairMintInfo,
        created_at: moment(microTime).toDate(),
      },
      {
        conflictPaths: ['tx_hash'],
      },
    );

    const savedTransaction = await pairTransactionRepository.findOne({
      where: { tx_hash: tx.hash },
      relations: {
        pair: true,
      },
    });

    if (!savedTransaction) {
      throw new Error(`Failed to create or retrieve transaction ${tx.hash}`);
    }

    return savedTransaction;
  }
}
