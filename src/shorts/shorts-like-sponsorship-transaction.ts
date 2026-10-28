import { BadRequestException } from '@nestjs/common';
import { AciContractCallEncoder } from '@aeternity/aepp-calldata';
import {
  buildTxHash,
  decode,
  hash,
  rebuildUnpackedTx,
  Tag,
  unpackTx,
  verifySignature,
  Encoding,
  isAddressValid,
} from '@aeternity/aepp-sdk';

export interface LikeSponsorshipPolicy {
  gasLimit: number;
  gasPrice: string;
  maxFee: string;
  maxTransactionCost: string;
  rollingCostLimit: string;
  maxPending: number;
  maxActorPerDay: number;
  maxRequestsPerDay: number;
  ttlBlocks: number;
}

export function likeSponsorshipPolicy(
  value: LikeSponsorshipPolicy,
): LikeSponsorshipPolicy {
  const integer = (n: number, max: number) =>
    Number.isSafeInteger(n) && n > 0 && n <= max;
  const amount = (n: string) =>
    typeof n === 'string' && /^[1-9]\d{0,29}$/.test(n);
  if (
    !value ||
    !integer(value.gasLimit, 200000) ||
    !integer(value.ttlBlocks, 50) ||
    !integer(value.maxPending, 100) ||
    !integer(value.maxActorPerDay, 1000) ||
    !integer(value.maxRequestsPerDay, 100000) ||
    ![
      value.gasPrice,
      value.maxFee,
      value.maxTransactionCost,
      value.rollingCostLimit,
    ].every(amount) ||
    BigInt(value.gasPrice) > 100000000000n ||
    BigInt(value.maxFee) > 10000000000000000n ||
    BigInt(value.maxTransactionCost) > 100000000000000000n ||
    BigInt(value.maxFee) + BigInt(value.gasLimit) * BigInt(value.gasPrice) >=
      BigInt(value.maxTransactionCost) ||
    BigInt(value.rollingCostLimit) < BigInt(value.maxTransactionCost)
  ) {
    throw new BadRequestException('Invalid Like sponsorship limits');
  }
  return {
    gasLimit: value.gasLimit,
    gasPrice: value.gasPrice,
    maxFee: value.maxFee,
    maxTransactionCost: value.maxTransactionCost,
    rollingCostLimit: value.rollingCostLimit,
    maxPending: value.maxPending,
    maxActorPerDay: value.maxActorPerDay,
    maxRequestsPerDay: value.maxRequestsPerDay,
    ttlBlocks: value.ttlBlocks,
  };
}

const encoder = new AciContractCallEncoder([
  {
    contract: {
      name: 'Shorts',
      kind: 'contract_main',
      typedefs: [],
      functions: [
        {
          name: 'like',
          arguments: [
            { name: 'id', type: 'string' },
            { name: 'expected_config_version', type: 'int' },
          ],
          returns: { tuple: [] },
          payable: false,
          stateful: true,
        },
      ],
    },
  },
]);
const signatureMatches = (
  unsigned: `tx_${string}`,
  signature: Uint8Array,
  actor: `ak_${string}`,
  domain: string,
) => {
  const binary = decode(unsigned);
  return [hash(binary), binary].some((payload) =>
    verifySignature(
      Buffer.concat([Buffer.from(domain), payload]),
      signature,
      actor,
    ),
  );
};

/** Pure allowlist validation. A valid wallet signature alone never authorizes sponsor spending. */
export function likeInnerTransaction(
  raw: string,
  expected: {
    actor: string;
    contract: string;
    network: string;
    policy: LikeSponsorshipPolicy;
    videoId?: string;
    height?: number;
  },
) {
  try {
    if (
      expected.network !== 'ae_uat' ||
      typeof raw !== 'string' ||
      raw.length > 8192 ||
      !isAddressValid(expected.actor, Encoding.AccountAddress) ||
      !isAddressValid(expected.contract, Encoding.ContractAddress)
    )
      throw new Error();
    const signed = unpackTx(raw as `tx_${string}`, Tag.SignedTx) as any;
    const call = signed.encodedTx;
    if (
      signed.signatures.length !== 1 ||
      call.tag !== Tag.ContractCallTx ||
      call.version !== 1 ||
      call.abiVersion !== 3 ||
      call.callerId !== expected.actor ||
      call.contractId !== expected.contract ||
      BigInt(call.amount) !== 0n ||
      !Number.isSafeInteger(call.nonce) ||
      call.nonce <= 0 ||
      !Number.isSafeInteger(call.ttl) ||
      call.ttl <= 0 ||
      !Number.isSafeInteger(call.gasLimit) ||
      call.gasLimit <= 0 ||
      call.gasLimit > expected.policy.gasLimit ||
      BigInt(call.gasPrice) <= 0n ||
      BigInt(call.gasPrice) > BigInt(expected.policy.gasPrice) ||
      BigInt(call.fee) <= 0n ||
      BigInt(call.fee) > BigInt(expected.policy.maxFee) ||
      rebuildUnpackedTx(signed) !== raw
    )
      throw new Error();
    const { args } = encoder.decodeCall('Shorts', 'like', call.callData);
    if (
      args.length !== 2 ||
      typeof args[0] !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(args[0]) ||
      (expected.videoId !== undefined && expected.videoId !== args[0]) ||
      !/^(0|[1-9]\d{0,77})$/.test(String(args[1])) ||
      encoder.encodeCall('Shorts', 'like', args) !== call.callData ||
      !signatureMatches(
        rebuildUnpackedTx(call),
        signed.signatures[0],
        call.callerId,
        `${expected.network}-inner_tx`,
      )
    )
      throw new Error();
    if (
      expected.height !== undefined &&
      (!Number.isSafeInteger(expected.height) ||
        call.ttl <= expected.height ||
        call.ttl > expected.height + expected.policy.ttlBlocks)
    )
      throw new Error();
    const cost =
      BigInt(call.fee) + BigInt(call.gasLimit) * BigInt(call.gasPrice);
    if (cost >= BigInt(expected.policy.maxTransactionCost)) throw new Error();
    return {
      innerHash: buildTxHash(raw as `tx_${string}`),
      actor: call.callerId as string,
      videoId: args[0],
      version: String(args[1]),
      nonce: call.nonce as number,
      ttl: call.ttl as number,
      cost: cost.toString(),
      call,
    };
  } catch {
    throw new BadRequestException(
      'Signed request is outside zero-payment Like sponsorship authority',
    );
  }
}

export function sponsoredLikeTransaction(
  raw: string,
  innerRaw: string,
  expected: {
    actor: string;
    contract: string;
    network: string;
    policy: LikeSponsorshipPolicy;
    payer: string;
    payerNonce?: number;
  },
) {
  const inner = likeInnerTransaction(innerRaw, expected);
  try {
    if (
      typeof raw !== 'string' ||
      raw.length > 16384 ||
      !isAddressValid(expected.payer, Encoding.AccountAddress)
    )
      throw new Error();
    const signed = unpackTx(raw as `tx_${string}`, Tag.SignedTx) as any;
    const outer = signed.encodedTx;
    if (
      signed.signatures.length !== 1 ||
      outer.tag !== Tag.PayingForTx ||
      outer.version !== 1 ||
      outer.payerId !== expected.payer ||
      !Number.isSafeInteger(outer.nonce) ||
      outer.nonce <= 0 ||
      (expected.payerNonce !== undefined &&
        outer.nonce !== expected.payerNonce) ||
      rebuildUnpackedTx(outer.tx) !== innerRaw ||
      rebuildUnpackedTx(signed) !== raw ||
      !signatureMatches(
        rebuildUnpackedTx(outer),
        signed.signatures[0],
        outer.payerId,
        expected.network,
      ) ||
      BigInt(outer.fee) <= 0n ||
      BigInt(outer.fee) > BigInt(expected.policy.maxFee)
    )
      throw new Error();
    const cost = BigInt(inner.cost) + BigInt(outer.fee);
    if (cost > BigInt(expected.policy.maxTransactionCost)) throw new Error();
    return {
      ...inner,
      outerHash: buildTxHash(raw as `tx_${string}`),
      payerNonce: outer.nonce as number,
      cost: cost.toString(),
    };
  } catch {
    throw new BadRequestException(
      'Sponsor envelope is outside its identity or spending limit',
    );
  }
}

/** The canonical unsigned envelope is reserved durably before a fee-key signature. */
export function unsignedSponsoredLikeTransaction(
  raw: string,
  innerRaw: string,
  expected: {
    actor: string;
    contract: string;
    network: string;
    policy: LikeSponsorshipPolicy;
    payer: string;
    payerNonce: number;
  },
) {
  const inner = likeInnerTransaction(innerRaw, expected);
  try {
    if (typeof raw !== 'string' || raw.length > 16384) throw new Error();
    const outer = unpackTx(raw as `tx_${string}`, Tag.PayingForTx) as any;
    if (
      outer.version !== 1 ||
      outer.payerId !== expected.payer ||
      outer.nonce !== expected.payerNonce ||
      !Number.isSafeInteger(outer.nonce) ||
      outer.nonce <= 0 ||
      rebuildUnpackedTx(outer) !== raw ||
      rebuildUnpackedTx(outer.tx) !== innerRaw ||
      BigInt(outer.fee) <= 0n ||
      BigInt(outer.fee) > BigInt(expected.policy.maxFee)
    )
      throw new Error();
    const cost = BigInt(inner.cost) + BigInt(outer.fee);
    if (cost > BigInt(expected.policy.maxTransactionCost)) throw new Error();
    return { nonce: outer.nonce as number, cost: cost.toString() };
  } catch {
    throw new BadRequestException(
      'Unsigned sponsor envelope exceeds its authority',
    );
  }
}
