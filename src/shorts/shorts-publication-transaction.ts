import { BadRequestException } from '@nestjs/common';
import type { ShortsRelease } from './shorts-release';
import { AciContractCallEncoder } from '@aeternity/aepp-calldata';
import {
  buildTxHash,
  decode,
  hash,
  rebuildUnpackedTx,
  Tag,
  unpackTx,
  verifySignature,
} from '@aeternity/aepp-sdk';

export interface PublicationIntent {
  id: string;
  creator: string;
  cid: string;
  bytes: number;
}
export interface PublishingPolicy {
  maxTransactionCost: string;
  rollingCostLimit: string;
  maxPending: number;
  maxCreatorPending: number;
  leaseMs: number;
  maxTtlBlocks: number;
  confirmations: number;
}

export function publishingPolicy(policy: PublishingPolicy): PublishingPolicy {
  const amounts = [policy?.maxTransactionCost, policy?.rollingCostLimit];
  if (
    amounts.some(
      (v) => typeof v !== 'string' || !/^[1-9][0-9]{0,59}$/.test(v),
    ) ||
    BigInt(policy.rollingCostLimit) < BigInt(policy.maxTransactionCost) ||
    !Number.isSafeInteger(policy.maxPending) ||
    policy.maxPending < 1 ||
    policy.maxPending > 1000 ||
    !Number.isSafeInteger(policy.maxCreatorPending) ||
    policy.maxCreatorPending < 1 ||
    policy.maxCreatorPending > policy.maxPending ||
    !Number.isSafeInteger(policy.leaseMs) ||
    policy.leaseMs < 1000 ||
    policy.leaseMs > 300000 ||
    !Number.isSafeInteger(policy.maxTtlBlocks) ||
    policy.maxTtlBlocks < 1 ||
    policy.maxTtlBlocks > 1000 ||
    !Number.isSafeInteger(policy.confirmations) ||
    policy.confirmations < 3 ||
    policy.confirmations > 100
  )
    throw new BadRequestException('Invalid publication limits');
  return {
    maxTransactionCost: policy.maxTransactionCost,
    rollingCostLimit: policy.rollingCostLimit,
    maxPending: policy.maxPending,
    maxCreatorPending: policy.maxCreatorPending,
    leaseMs: policy.leaseMs,
    maxTtlBlocks: policy.maxTtlBlocks,
    confirmations: policy.confirmations,
  };
}

// This allowlist encodes only the nonpayable publication method. The isolated
// signer must separately verify the deployed bytecode/source and full artifact.
const encoder = new AciContractCallEncoder([
  {
    contract: {
      name: 'Shorts',
      kind: 'contract_main',
      typedefs: [],
      functions: [
        {
          name: 'publish',
          arguments: [
            { name: 'id', type: 'string' },
            { name: 'creator', type: 'address' },
            { name: 'cid', type: 'string' },
            { name: 'size', type: 'int' },
          ],
          returns: { tuple: [] },
          payable: false,
          stateful: true,
        },
      ],
    },
  },
]);

export function publicationCalldata(intent: PublicationIntent) {
  return encoder.encodeCall('Shorts', 'publish', [
    intent.id,
    intent.creator,
    intent.cid,
    intent.bytes,
  ]);
}

/** Offline validation only; never obtains a key, calls a node or broadcasts. */
export function publicationTransaction(
  raw: string,
  intent: PublicationIntent,
  contract: string,
  operator: string,
  accountNonce: number,
  height: number,
  policy: PublishingPolicy,
  network: ShortsRelease['network'],
) {
  try {
    if (
      !['ae_uat', 'ae_mainnet'].includes(network) ||
      typeof raw !== 'string' ||
      raw.length > 32768 ||
      !raw.startsWith('tx_') ||
      !Number.isSafeInteger(accountNonce) ||
      accountNonce < 0 ||
      !Number.isSafeInteger(height) ||
      height < 0
    )
      throw new Error();
    // The SDK's recursive unpacked declaration omits nested fields in this
    // TypeScript build. Validate every signing-relevant field below at runtime.
    const signed = unpackTx(raw as `tx_${string}`, Tag.SignedTx) as any;
    if (signed.tag !== Tag.SignedTx || signed.signatures.length !== 1)
      throw new Error();
    const call = signed.encodedTx;
    if (
      call.tag !== Tag.ContractCallTx ||
      call.version !== 1 ||
      call.abiVersion !== 3 ||
      call.callerId !== operator ||
      call.contractId !== contract ||
      call.callData !== publicationCalldata(intent) ||
      BigInt(call.amount) !== 0n ||
      !Number.isSafeInteger(call.nonce) ||
      call.nonce !== accountNonce + 1 ||
      !Number.isSafeInteger(call.ttl) ||
      call.ttl <= height ||
      call.ttl > height + policy.maxTtlBlocks ||
      !Number.isSafeInteger(call.gasLimit) ||
      call.gasLimit <= 0
    )
      throw new Error();
    const unsigned = decode(rebuildUnpackedTx(call));
    if (
      !verifySignature(
        Buffer.concat([Buffer.from(network), hash(unsigned)]),
        signed.signatures[0],
        operator as `ak_${string}`,
      )
    )
      throw new Error();
    const fee = BigInt(call.fee),
      gasPrice = BigInt(call.gasPrice);
    const cost = fee + BigInt(call.gasLimit) * gasPrice;
    if (fee <= 0n || gasPrice <= 0n || cost > BigInt(policy.maxTransactionCost))
      throw new Error();
    return {
      hash: buildTxHash(raw as `tx_${string}`),
      nonce: call.nonce,
      ttl: call.ttl,
      cost: cost.toString(),
    };
  } catch {
    throw new BadRequestException(
      'Signed transaction is outside publication authority or budget',
    );
  }
}
