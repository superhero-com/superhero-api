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
  decode,
  encode,
} from '@aeternity/aepp-sdk';
import { shortsContractPolicy, shortsVideo } from './shorts-contract-policy';
import { shortsInnerContractCall } from './shorts-contract-call';
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
  shortsLikeMode,
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
  rewards: { contract: Contract<any>; artifact: any }[] = [];
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
      this.release.rewardContracts?.map((item) => item.contract) ?? [],
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
    const previousAddress =
      deployment.schemaVersion === 2
        ? await this.importSource()
        : await this.read('get_previous');
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
      this.rewards.push({
        contract: this.previous,
        artifact: this.previousArtifact,
      });
    }
    if (deployment.rewardContracts?.length) {
      const artifacts = await shortsConfigJson(
        process.env.SHORTS_REWARD_ARTIFACTS_FILE,
      );
      for (const identity of deployment.rewardContracts) {
        const artifact = shortsArtifact(artifacts[identity.contract], identity);
        const code = await this.sdk.api.getContractCode(identity.contract);
        if (
          createHash('sha256').update(code.bytecode).digest('hex') !==
          identity.bytecodeHash
        )
          throw new Error('Reward contract bytecode mismatch');
        this.rewards.push({
          artifact,
          contract: await Contract.initialize({
            ...this.sdk.getContext(),
            aci: artifact.aci,
            address: identity.contract,
          }),
        });
      }
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
    if (method === 'get_short' && this.release.schemaVersion === 2) {
      return this.readNode(async () => {
        const video = await shortsVideo(this.contract, String(args[0]), 2);
        if (!video) return undefined;
        const stats = (
          await this.contract.$call('get_video_stats', args, {
            callStatic: true,
          })
        ).decodedResult;
        return { ...video, likes: stats.likes, comments: stats.comments };
      }, signal);
    }
    return this.readNode(
      async () => (await this.invoke(method, args, true)).decodedResult,
      signal,
    );
  }
  async policy(signal?: AbortSignal) {
    return shortsContractPolicy(
      await this.read('get_config', [], signal),
      this.release.schemaVersion,
    );
  }
  private async importSource() {
    if (BigInt(await this.read('schema_version')) !== 2n)
      throw new Error('Unsupported Shorts schema');
    const [native, legacy] = await this.read('get_import_source');
    const address = native || legacy?.source;
    return address
      ? encode(decode(address), Encoding.ContractAddress)
      : undefined;
  }
  rewardContracts() {
    // Compatibility for unit fixtures and legacy single-predecessor releases.
    return this.rewards.length
      ? this.rewards
      : this.previous
        ? [{ contract: this.previous, artifact: this.previousArtifact }]
        : [];
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
    const call = shortsInnerContractCall(transaction.tx);
    const result = (info as any).callInfo;
    if (
      transaction.hash !== tx ||
      !Number.isSafeInteger(transaction.blockHeight) ||
      transaction.blockHeight < 0 ||
      !call ||
      call.callerId !== address ||
      ![
        this.state.contract,
        ...this.rewardContracts().map((item) => item.contract.$options.address),
      ].includes(call.contractId) ||
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
      const freeLikes =
        this.release.schemaVersion === 2 &&
        shortsLikeMode(this.release, this.artifact, await this.policy()) ===
          'free';
      const balance = freeLikes
        ? { available: 0n, earned: 0n, claimed: 0n }
        : await this.read('get_account', [address]);
      const rewards = [];
      for (const item of this.rewardContracts()) {
        // A content predecessor may itself be a free contract with no rewards API.
        // Keep it in the event index, but do not invent a call to a removed getter.
        const functions = item.artifact?.aci?.flatMap(
          (entry: any) => entry.contract?.functions || [],
        );
        if (
          functions &&
          !functions.some((fn: any) =>
            ['get_account', 'claim'].includes(fn.name),
          )
        )
          continue;
        const old = (
          await item.contract.$call('get_account', [address], {
            callStatic: true,
          })
        ).decodedResult;
        rewards.push({ contract: item.contract.$options.address, ...old });
      }
      return {
        address,
        wallet: ae(
          await this.sdk.getBalance(address as `ak_${string}`).catch(() => '0'),
        ),
        available: ae(balance.available),
        earned: ae(
          rewards.reduce(
            (sum, old) => sum + BigInt(old.earned || 0),
            BigInt(balance.earned),
          ),
        ),
        claimed: ae(
          rewards.reduce(
            (sum, old) => sum + BigInt(old.claimed || 0),
            BigInt(balance.claimed),
          ),
        ),
        previousAvailable: rewards[0] ? ae(rewards[0].available) : '0',
        rewardAccounts: rewards.map((old) => ({
          contract: old.contract,
          available: ae(old.available),
        })),
      };
    });
  }
}
