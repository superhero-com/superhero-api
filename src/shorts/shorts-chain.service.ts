import { assertShortsEnvironment } from './shorts-environment';
import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  AeSdk,
  AccountMemory,
  Node,
  Contract,
  isAddressValid,
  Encoding,
  DryRunError,
} from '@aeternity/aepp-sdk';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LocalState } from './shorts.types';
import { ShortsStoreService, SHORTS_DATA_DIR } from './shorts-store.service';

export const LOCAL_DIR = SHORTS_DATA_DIR;
export const AE = 10n ** 18n;
export function ae(value: bigint | string) {
  const n = BigInt(value);
  const fraction = (n % AE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${n / AE}${fraction ? `.${fraction}` : ''}`;
}
@Injectable()
export class ShortsChainService implements OnModuleInit {
  sdk: AeSdk;
  contract: Contract<any>;
  operator: AccountMemory;
  artifact: any;
  previous?: Contract<any>;
  previousArtifact?: any;
  state: LocalState = { shorts: [], receipts: [] };
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: ShortsStoreService) {}
  async onModuleInit() {
    assertShortsEnvironment();
    const {
      SHORTS_OPERATOR_KEY_FILE,
      SHORTS_DEPLOYMENT_FILE,
      SHORTS_CONTRACT_ARTIFACT,
    } = process.env;
    if (
      !SHORTS_OPERATOR_KEY_FILE ||
      !SHORTS_DEPLOYMENT_FILE ||
      !SHORTS_CONTRACT_ARTIFACT
    )
      throw new Error('Missing testnet contract configuration');
    const key = JSON.parse(await readFile(SHORTS_OPERATOR_KEY_FILE, 'utf8'));
    this.operator = new AccountMemory(key.secretKey);
    const deployment = JSON.parse(
      await readFile(SHORTS_DEPLOYMENT_FILE, 'utf8'),
    );
    this.artifact = JSON.parse(
      await readFile(resolve(SHORTS_CONTRACT_ARTIFACT), 'utf8'),
    );
    if (
      deployment.network !== 'ae_uat' ||
      deployment.operator !== this.operator.address ||
      deployment.bytecodeHash !== this.artifact.bytecodeHash
    )
      throw new Error('Deployment identity mismatch');
    this.sdk = new AeSdk({
      accounts: [this.operator],
      nodes: [
        { name: 'testnet', instance: new Node('https://testnet.aeternity.io') },
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
    if (previousAddress) {
      const oldDeployment = JSON.parse(
        await readFile(process.env.SHORTS_PREVIOUS_DEPLOYMENT_FILE!, 'utf8'),
      );
      this.previousArtifact = JSON.parse(
        await readFile(process.env.SHORTS_PREVIOUS_CONTRACT_ARTIFACT!, 'utf8'),
      );
      const oldCode = await this.sdk.api.getContractCode(previousAddress);
      if (
        oldDeployment.contract !== previousAddress ||
        oldDeployment.network !== 'ae_uat' ||
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
    this.state = this.store.load() || this.state;
    if (this.state.contract && this.state.contract !== deployment.contract) {
      if (this.state.contract !== previousAddress)
        throw new Error('State belongs to another deployment');
      // Only previously published records migrate automatically. Private drafts stay private.
      for (const short of this.state.shorts) {
        const old = (
          await this.previous!.$call('get_short', [short.id], {
            callStatic: true,
          })
        ).decodedResult;
        if (old) short.publication = old.withdrawn ? 'withdrawn' : 'pending';
      }
    }
    this.state.contract = deployment.contract;
    this.state.sourceHash = deployment.sourceHash;
    await this.save();
    const cfg = await this.read('get_config');
    if (cfg[0] !== this.operator.address) throw new Error('Operator mismatch');
  }
  address(value: string) {
    if (!isAddressValid(value, Encoding.AccountAddress))
      throw new Error('Invalid AE address');
    return value;
  }
  async assertTestnet() {
    if ((await this.sdk.getNodeInfo()).nodeNetworkId !== 'ae_uat')
      throw new Error('Refusing non-testnet transaction');
  }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async read(method: string, args: unknown[] = []): Promise<any> {
    return (await this.invoke(method, args, true)).decodedResult;
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
    if (method !== 'publish')
      throw new Error('User payments must be signed by their wallet');
    await this.assertTestnet();
    const result = await this.invoke(method, args);
    this.state.receipts.unshift({
      actor: this.operator.address,
      action: method,
      tx: result.hash,
      at: Date.now(),
    });
    await this.save();
    return { hash: result.hash, decodedResult: result.decodedResult };
  }
  async recordTransaction(address: string, tx: string) {
    if (!/^th_[1-9A-HJ-NP-Za-km-z]+$/.test(tx))
      throw new Error('Invalid transaction');
    const [transaction, info] = await Promise.all([
      this.sdk.api.getTransactionByHash(tx),
      this.sdk.api.getTransactionInfoByHash(tx),
    ]);
    const call = transaction.tx as any;
    const result = (info as any).callInfo;
    if (
      transaction.blockHeight < 0 ||
      call.callerId !== address ||
      ![this.state.contract, this.previous?.$options.address].includes(
        call.contractId,
      ) ||
      result?.returnType !== 'ok'
    )
      throw new Error('Successful mined wallet call to Shorts required');
    if (!this.state.receipts.some((r) => r.tx === tx)) {
      this.state.receipts.unshift({
        actor: address,
        action: 'wallet_transaction',
        tx,
        at: Date.now(),
      });
      await this.save();
    }
    return { tx };
  }
  async save() {
    this.store.save(this.state);
  }
  async account(address: string) {
    this.address(address);
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
  }
}
