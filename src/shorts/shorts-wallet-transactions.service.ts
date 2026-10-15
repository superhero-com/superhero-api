import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AciContractCallEncoder } from '@aeternity/aepp-calldata';
import {
  buildTx,
  buildTxHash,
  decode,
  Encoding,
  hash,
  isAddressValid,
  Tag,
  verifySignature,
} from '@aeternity/aepp-sdk';
import { ShortsChainService } from './shorts-chain.service';
import { receiptHash } from './shorts-receipts.service';
import type { ShortsRelease } from './shorts-release';

const confirmationsRequired = 3; // Same convention as the Shorts accounting index.
const methods = ['paid_like', 'claim', 'withdraw'] as const;
const encoder = new AciContractCallEncoder([
  {
    contract: {
      name: 'Shorts',
      kind: 'contract_main',
      typedefs: [],
      functions: methods.map((name) => ({
        name,
        arguments: name === 'claim' ? [] : [{ name: 'id', type: 'string' }],
        returns: { tuple: [] },
        payable: name === 'paid_like',
        stateful: true,
      })),
    },
  },
]);

/** Public chain observations only: never signs, submits, approves or writes a receipt. */
@Injectable()
export class ShortsWalletTransactionsService {
  constructor(private readonly chain: ShortsChainService) {}

  private identity(
    transaction: any,
    tx: string,
    actor: string,
    contract: string,
    network: ShortsRelease['network'],
  ) {
    try {
      const call = transaction.tx;
      // The node omits TTL when its encoded value is zero (no expiry).
      // Rebuilding the signed hash below still binds this default to the tx.
      const ttl = call.ttl === undefined ? 0 : call.ttl;
      if (
        transaction.hash !== tx ||
        call.type !== 'ContractCallTx' ||
        call.version !== 1 ||
        call.abiVersion !== 3 ||
        call.callerId !== actor ||
        call.contractId !== contract ||
        !Number.isSafeInteger(call.nonce) ||
        call.nonce <= 0 ||
        !Number.isSafeInteger(ttl) ||
        ttl < 0 ||
        !Array.isArray(transaction.signatures) ||
        transaction.signatures.length !== 1 ||
        typeof call.callData !== 'string' ||
        call.callData.length > 4096
      )
        throw new Error();
      const unsigned = buildTx({
        tag: Tag.ContractCallTx,
        version: 1,
        abiVersion: 3,
        callerId: call.callerId,
        contractId: call.contractId,
        nonce: call.nonce,
        amount: call.amount,
        fee: call.fee,
        ttl,
        gasLimit: call.gas,
        gasPrice: call.gasPrice,
        callData: call.callData,
      });
      const signature = decode(transaction.signatures[0]);
      const signed = buildTx({
        tag: Tag.SignedTx,
        encodedTx: unsigned,
        signatures: [signature],
      });
      const binary = decode(unsigned);
      if (
        buildTxHash(signed) !== tx ||
        // Match the SDK's modern hash and legacy raw-byte signing formats.
        ![hash(binary), binary].some((payload) =>
          verifySignature(
            Buffer.concat([Buffer.from(network), payload]),
            signature,
            actor as `ak_${string}`,
          ),
        )
      )
        throw new Error();
      for (const method of methods) {
        try {
          const { args } = encoder.decodeCall('Shorts', method, call.callData);
          if (encoder.encodeCall('Shorts', method, args) !== call.callData)
            continue;
          if (contract !== this.chain.state.contract && method !== 'claim')
            continue;
          if (
            method !== 'claim' &&
            (typeof args[0] !== 'string' || args[0].length > 128)
          )
            continue;
          return {
            method,
            videoId: method === 'claim' ? undefined : (args[0] as string),
            amount: BigInt(call.amount).toString(),
            nonce: call.nonce,
          };
        } catch {
          /* Try only the other explicitly supported wallet actions. */
        }
      }
      throw new Error();
    } catch {
      throw new BadRequestException(
        'Transaction does not match this Shorts wallet action',
      );
    }
  }

  async observe(tx: string, actor: string, contract: string) {
    receiptHash(tx);
    if (
      !isAddressValid(actor, Encoding.AccountAddress) ||
      !isAddressValid(contract, Encoding.ContractAddress)
    )
      throw new BadRequestException('Invalid wallet or contract address');
    if (!this.chain.state.contract || !this.chain.sdk)
      throw new ServiceUnavailableException(
        'Shorts deployment is not initialized',
      );
    if (
      ![
        this.chain.state.contract,
        this.chain.previous?.$options.address,
      ].includes(contract)
    )
      throw new BadRequestException('Unrecognized Shorts contract');
    const release = this.chain.release;
    const network = release?.network;
    const currentContract = release?.contract;
    const previousContract = release?.previousContract;
    const node = this.chain.sdk.api;
    const assertBinding = () => {
      if (
        !release ||
        !['ae_uat', 'ae_mainnet'].includes(network) ||
        this.chain.release !== release ||
        release.network !== network ||
        release.contract !== currentContract ||
        release.previousContract !== previousContract ||
        currentContract !== this.chain.state.contract ||
        (previousContract || undefined) !==
          this.chain.previous?.$options.address ||
        this.chain.sdk.api !== node
      )
        throw new ServiceUnavailableException(
          'Shorts observation release mismatch',
        );
    };
    assertBinding();
    const base = {
      tx,
      address: actor,
      contract,
      network,
      confirmationsRequired,
    };
    return this.chain.readNode(async () => {
      try {
        return await this.observeBound(
          node,
          network,
          tx,
          actor,
          contract,
          base,
        );
      } finally {
        // A changed scope must stay unresolved even if its response fails signature
        // validation. Never turn a cross-network response into a rejected payment.
        assertBinding();
        if ((await node.getStatus()).networkId !== network)
          throw new ServiceUnavailableException(
            'Transaction node network changed',
          );
        assertBinding();
      }
    });
  }

  private async observeBound(
    node: ShortsChainService['sdk']['api'],
    network: ShortsRelease['network'],
    tx: string,
    actor: string,
    contract: string,
    base: {
      tx: string;
      address: string;
      contract: string;
      network: ShortsRelease['network'];
      confirmationsRequired: number;
    },
  ) {
    if ((await node.getStatus()).networkId !== network)
      throw new ServiceUnavailableException(
        'Transaction node network mismatch',
      );
    let transaction;
    try {
      transaction = await node.getTransactionByHash(tx);
    } catch (error) {
      // Absence on this node is not proof of rejection, expiry or no payment.
      if (
        error &&
        typeof error === 'object' &&
        'statusCode' in error &&
        error.statusCode === 404
      )
        return { ...base, status: 'unknown', confirmations: 0 };
      throw error;
    }
    const intent = this.identity(transaction, tx, actor, contract, network);
    const result = { ...base, ...intent };
    if (transaction.blockHeight === -1 && transaction.blockHash === 'none')
      return { ...result, status: 'submitted', confirmations: 0 };
    if (
      !Number.isSafeInteger(transaction.blockHeight) ||
      transaction.blockHeight < 0
    )
      throw new ServiceUnavailableException('Invalid transaction block height');
    receiptHash(transaction.blockHash, 'mh_');
    const before = await node.getCurrentKeyBlock();
    receiptHash(before.hash, 'kh_');
    if (
      !Number.isSafeInteger(before.height) ||
      before.height < transaction.blockHeight
    )
      throw new ServiceUnavailableException(
        'Transaction node height is inconsistent',
      );
    const generation = await node.getGenerationByHeight(
      transaction.blockHeight,
    );
    if (
      generation?.keyBlock?.height !== transaction.blockHeight ||
      !Array.isArray(generation?.microBlocks)
    )
      throw new ServiceUnavailableException('Invalid canonical generation');
    receiptHash(generation.keyBlock.hash, 'kh_');
    const anchor = {
      blockHash: transaction.blockHash,
      blockHeight: transaction.blockHeight,
    };
    if (!generation.microBlocks.includes(transaction.blockHash))
      return { ...result, ...anchor, status: 'reorged', confirmations: 0 };
    const info = (await node.getTransactionInfoByHash(tx))?.callInfo;
    if (
      !info ||
      info.callerId !== actor ||
      info.contractId !== contract ||
      info.callerNonce !== intent.nonce ||
      info.height !== transaction.blockHeight ||
      !['ok', 'revert', 'error'].includes(info.returnType)
    )
      throw new ServiceUnavailableException(
        'Transaction execution evidence is inconsistent',
      );
    // Reject observations assembled across a changing tip or generation.
    const [after, current] = await Promise.all([
      node.getCurrentKeyBlock(),
      node.getGenerationByHeight(transaction.blockHeight),
    ]);
    if (
      before.hash !== after?.hash ||
      before.height !== after?.height ||
      generation.keyBlock.hash !== current?.keyBlock?.hash ||
      current?.keyBlock?.height !== transaction.blockHeight ||
      !Array.isArray(current?.microBlocks) ||
      !current.microBlocks.includes(transaction.blockHash)
    )
      throw new ServiceUnavailableException(
        'Transaction confirmation changed; check again',
      );
    const confirmations = before.height - transaction.blockHeight + 1;
    const status =
      confirmations < confirmationsRequired
        ? 'mined'
        : info.returnType === 'ok'
          ? 'confirmed'
          : 'failed';
    return {
      ...result,
      ...anchor,
      status,
      confirmations,
      result: info.returnType,
    };
  }
}
