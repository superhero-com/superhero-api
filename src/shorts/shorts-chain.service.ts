import { shortsRuntimeScope } from './shorts-runtime-scope';
import { assertShortsEnvironment } from './shorts-environment';
import {
  Injectable,
  OnModuleInit,
  OnApplicationBootstrap,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AeSdk,
  AccountMemory,
  Contract,
  isAddressValid,
  Encoding,
  DryRunError,
} from '@aeternity/aepp-sdk';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { LocalState, ShortRecord } from './shorts.types';
import { ShortsStoreService, SHORTS_DATA_DIR } from './shorts-store.service';
import { ShortsWorkQueueService } from './shorts-work-queue.service';
import {
  ShortsReceiptsService,
  ReceiptObservation,
  receiptHash,
} from './shorts-receipts.service';
import { ShortsScope } from './shorts-metadata.service';
import { ShortsNodeAccessService } from './shorts-node-access.service';
import {
  ShortsRelease,
  shortsConfigJson,
  loadShortsRelease,
  shortsArtifact,
  assertShortsReleaseConfig,
} from './shorts-release';

export const LOCAL_DIR = SHORTS_DATA_DIR;
export const AE = 10n ** 18n;
export function ae(value: bigint | string) {
  const n = BigInt(value);
  const fraction = (n % AE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${n / AE}${fraction ? `.${fraction}` : ''}`;
}
@Injectable()
export class ShortsChainService
  implements OnModuleInit, OnApplicationBootstrap
{
  sdk: AeSdk;
  contract: Contract<any>;
  operator: Pick<AccountMemory, 'address'>;
  artifact: any;
  release: ShortsRelease;
  previous?: Contract<any>;
  previousArtifact?: any;
  state: LocalState = { shorts: [], receipts: [] };
  private receiptScope?: ShortsScope;
  constructor(
    private readonly store: ShortsStoreService,
    private readonly work: ShortsWorkQueueService,
    @Optional() private readonly receipts?: ShortsReceiptsService,
    @Optional()
    private readonly nodeAccess: ShortsNodeAccessService = new ShortsNodeAccessService(),
  ) {}
  get sharedReceipts() {
    return this.receipts?.shared === true;
  }
  async onApplicationBootstrap() {
    if (!this.sharedReceipts) {
      if (process.env.NODE_ENV === 'production')
        throw new Error('Hosted Shorts require shared transaction history');
      return;
    }
    if (!this.state.contract)
      throw new ServiceUnavailableException(
        'Shorts deployment is not initialized',
      );
    const scope = shortsRuntimeScope(this);
    await this.receipts!.initialize(
      scope,
      this.state.sourceHash!,
      this.previous?.$options.address,
      this.state.receipts,
      process.env.SHORTS_IMPORT_LEGACY_RECEIPTS === '1',
    );
    this.receiptScope = scope;
  }
  private readyReceiptScope() {
    if (!this.receiptScope)
      throw new ServiceUnavailableException(
        'Transaction history is not initialized',
      );
    shortsRuntimeScope(this);
    return this.receiptScope;
  }
  private async saveReceipt(observation: ReceiptObservation) {
    if (this.sharedReceipts)
      return this.receipts!.record(this.readyReceiptScope(), observation);
    if (this.state.receipts.some((r) => r.tx === observation.tx)) return;
    const receipt = {
      actor: observation.actor,
      action: observation.action,
      tx: observation.tx,
      at: Date.now(),
    };
    this.state.receipts.unshift(receipt);
    try {
      this.store.save(this.state);
    } catch (error) {
      this.state.receipts = this.state.receipts.filter((r) => r !== receipt);
      throw error;
    }
  }
  async receiptHistory(actor: string) {
    if (this.sharedReceipts)
      return (await this.receipts!.list(this.readyReceiptScope(), actor)).items;
    return this.state.receipts.filter((r) => r.actor === actor).slice(0, 15);
  }
  async onModuleInit() {
    assertShortsEnvironment();
    const {
      SHORTS_OPERATOR_KEY_FILE,
      SHORTS_DEPLOYMENT_FILE,
      SHORTS_CONTRACT_ARTIFACT,
    } = process.env;
    if (this.sharedReceipts && SHORTS_OPERATOR_KEY_FILE)
      throw new Error('Mount the operator key only in the isolated publisher');
    if (process.env.NODE_ENV === 'production' && !this.sharedReceipts)
      throw new Error('Hosted Shorts require shared publishing');
    if (
      (!this.sharedReceipts && !SHORTS_OPERATOR_KEY_FILE) ||
      !SHORTS_DEPLOYMENT_FILE ||
      !SHORTS_CONTRACT_ARTIFACT
    )
      throw new Error('Missing testnet contract configuration');
    const deployment = await loadShortsRelease();
    this.artifact = shortsArtifact(
      await shortsConfigJson(SHORTS_CONTRACT_ARTIFACT),
      deployment,
    );
    this.release = deployment;
    const localAccount = this.sharedReceipts
      ? undefined
      : new AccountMemory(
          JSON.parse(await readFile(SHORTS_OPERATOR_KEY_FILE, 'utf8'))
            .secretKey,
        );
    this.operator = localAccount || { address: deployment.operator };
    if (deployment.operator !== this.operator.address)
      throw new Error('Deployment identity mismatch');
    this.sdk = new AeSdk({
      accounts: localAccount ? [localAccount] : [],
      nodes: [
        {
          name: deployment.network,
          instance: this.nodeAccess.createNode(
            deployment.node,
            !this.sharedReceipts,
          ),
        },
      ],
      interval: 1500,
    });
    await this.assertTestnet();
    const code = await this.sdk.api.getContractCode(deployment.contract);
    if (
      createHash('sha256').update(code.bytecode).digest('hex') !==
      this.artifact.bytecodeHash
    )
      throw new Error('On-chain bytecode mismatch');
    this.contract = await Contract.initialize({
      ...this.sdk.getContext(),
      aci: this.artifact.aci,
      address: deployment.contract,
    });
    const previousAddress = await this.read('get_previous');
    if ((previousAddress || null) !== deployment.previousContract)
      throw new Error('Previous contract does not match the release manifest');
    assertShortsReleaseConfig(deployment, await this.read('get_config'));
    if (previousAddress) {
      const oldDeployment = await shortsConfigJson(
        process.env.SHORTS_PREVIOUS_DEPLOYMENT_FILE!,
      );
      this.previousArtifact = shortsArtifact(
        await shortsConfigJson(process.env.SHORTS_PREVIOUS_CONTRACT_ARTIFACT!),
        deployment.previousArtifact!,
      );
      const oldCode = await this.sdk.api.getContractCode(previousAddress);
      if (
        oldDeployment.contract !== previousAddress ||
        oldDeployment.network !== deployment.network ||
        oldDeployment.compiler !== this.previousArtifact.compiler ||
        oldDeployment.sourceHash !== this.previousArtifact.sourceHash ||
        oldDeployment.bytecodeHash !== this.previousArtifact.bytecodeHash ||
        createHash('sha256').update(oldCode.bytecode).digest('hex') !==
          oldDeployment.bytecodeHash
      )
        throw new Error('Previous deployment identity mismatch');
      this.previous = await Contract.initialize({
        ...this.sdk.getContext(),
        aci: this.previousArtifact.aci,
        address: previousAddress,
      });
    }
    if (!this.sharedReceipts) this.state = this.store.load() || this.state;
    if (this.state.contract && this.state.contract !== deployment.contract) {
      if (this.state.contract !== previousAddress)
        throw new Error('State belongs to another deployment');
      // Only previously published records migrate automatically. Private drafts stay private.
      for (const short of this.state.shorts) {
        const old = (
          await this.readNode(() =>
            this.previous!.$call('get_short', [short.id], {
              callStatic: true,
            }),
          )
        ).decodedResult;
        if (old) short.publication = old.withdrawn ? 'withdrawn' : 'pending';
      }
    }
    this.state.contract = deployment.contract;
    this.state.sourceHash = deployment.sourceHash;
    if (!this.sharedReceipts) await this.save();
  }
  address(value: string) {
    if (!isAddressValid(value, Encoding.AccountAddress))
      throw new Error('Invalid AE address');
    return value;
  }
  async assertTestnet() {
    if (
      (await this.readNode(() => this.sdk.api.getStatus())).networkId !==
      this.release.network
    )
      throw new Error('Refusing non-testnet transaction');
  }
  serial<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.work.run(fn, signal);
  }
  /** Commit a prepared draft without waiting behind a slow network operation. */
  registerPrepared(short: ShortRecord) {
    if (this.sharedReceipts)
      throw new Error('Hosted drafts require shared metadata');
    const existing = this.state.shorts.find((s) => s.id === short.id);
    if (existing) {
      if (existing.creator !== short.creator)
        throw new Error('Upload identity mismatch');
      return existing;
    }
    if (this.state.shorts.length >= 50)
      throw new Error('Local preview is limited to 50 videos');
    // This critical section contains no await. The exclusive SQLite owner
    // persists the current shared snapshot before another callback can run.
    this.state.shorts.unshift(short);
    try {
      this.store.save(this.state);
      return short;
    } catch (error) {
      this.state.shorts = this.state.shorts.filter((s) => s !== short);
      throw error;
    }
  }
  readNode<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.nodeAccess.read(operation, signal);
  }
  async read(
    method: string,
    args: unknown[] = [],
    signal?: AbortSignal,
  ): Promise<any> {
    return this.readNode(
      async () => (await this.invoke(method, args, true)).decodedResult,
      signal,
    );
  }
  private async invoke(method: string, args: unknown[], callStatic = false) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.contract.$call(method, args, { callStatic });
      } catch (error) {
        // The SDK raises DryRunError before signing/broadcasting. A recently
        // mined operator call can invalidate the nonce used by its simulation.
        // Never retry submission failures or ambiguous transaction timeouts.
        if (
          !(error instanceof DryRunError) ||
          !/tx_nonce_(already_used|too_high)_for_account/.test(error.message) ||
          attempt >= 2
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  async write(
    method: string,
    args: unknown[],
  ): Promise<{ hash: string; decodedResult: any }> {
    if (this.sharedReceipts)
      throw new Error('Hosted API cannot sign publication transactions');
    if (method !== 'publish')
      throw new Error('User payments must be signed by their wallet');
    await this.assertTestnet();
    const result = await this.invoke(method, args);
    await this.saveReceipt({
      actor: this.operator.address,
      action: method,
      tx: result.hash,
      calledContract: this.state.contract!,
      verification: 'submitted',
    });
    return { hash: result.hash, decodedResult: result.decodedResult };
  }
  async recordTransaction(address: string, tx: string) {
    receiptHash(tx);
    this.address(address);
    await this.assertTestnet();
    const [transaction, info] = await Promise.all([
      this.sdk.api.getTransactionByHash(tx),
      this.sdk.api.getTransactionInfoByHash(tx),
    ]);
    const call = transaction.tx as any;
    const result = (info as any).callInfo;
    if (
      transaction.hash !== tx ||
      !Number.isSafeInteger(transaction.blockHeight) ||
      transaction.blockHeight < 0 ||
      call.type !== 'ContractCallTx' ||
      call.callerId !== address ||
      ![this.state.contract, this.previous?.$options.address].includes(
        call.contractId,
      ) ||
      result?.returnType !== 'ok' ||
      result.callerId !== address ||
      result.contractId !== call.contractId ||
      result.height !== transaction.blockHeight
    )
      throw new Error('Successful mined wallet call to Shorts required');
    receiptHash(transaction.blockHash, 'mh_');
    const generation = await this.sdk.api.getGenerationByHeight(
      transaction.blockHeight,
    );
    if (!generation.microBlocks.includes(transaction.blockHash))
      throw new Error('Transaction is no longer in the node generation');
    await this.saveReceipt({
      actor: address,
      action: 'wallet_transaction',
      tx,
      calledContract: call.contractId,
      verification: 'node_observed',
      blockHash: transaction.blockHash,
      blockHeight: transaction.blockHeight,
    });
    return { tx };
  }
  async save() {
    if (this.sharedReceipts)
      throw new Error(
        'Hosted state must be persisted by its shared repository',
      );
    this.store.save(this.state);
  }
  async account(address: string) {
    this.address(address);
    return this.readNode(async () => {
      const balance = await this.read('get_account', [address]);
      const old = this.previous
        ? (
            await this.previous.$call('get_account', [address], {
              callStatic: true,
            })
          ).decodedResult
        : undefined;
      return {
        address,
        wallet: ae(
          await this.sdk.getBalance(address as `ak_${string}`).catch(() => '0'),
        ),
        available: ae(balance.available),
        earned: ae(BigInt(balance.earned) + BigInt(old?.earned || 0)),
        claimed: ae(BigInt(balance.claimed) + BigInt(old?.claimed || 0)),
        previousAvailable: old ? ae(old.available) : '0',
      };
    });
  }
}
