import { buildTx, decode, Tag } from '@aeternity/aepp-sdk';
import { ServiceUnavailableException } from '@nestjs/common';
import { receiptHash } from './shorts-receipts.service';
import {
  sponsoredLikeTransaction,
  LikeSponsorshipPolicy,
} from './shorts-like-sponsorship-transaction';

/** Rebuild both signed layers from the node response, rejecting additional nesting. */
export function signedWalletTransactionFromNode(
  transaction: any,
  inner = false,
): `tx_${string}` {
  if (
    !transaction ||
    !Array.isArray(transaction.signatures) ||
    transaction.signatures.length !== 1
  )
    throw new Error('Invalid signed envelope');
  const value = transaction.tx;
  let encodedTx: `tx_${string}`;
  if (value?.type === 'ContractCallTx') {
    if (value.version !== 1 || value.abiVersion !== 3)
      throw new Error('Unsupported call');
    encodedTx = buildTx({
      tag: Tag.ContractCallTx,
      version: 1,
      abiVersion: 3,
      callerId: value.callerId,
      contractId: value.contractId,
      nonce: value.nonce,
      amount: value.amount,
      fee: value.fee,
      ttl: value.ttl ?? 0,
      gasLimit: value.gas,
      gasPrice: value.gasPrice,
      callData: value.callData,
    });
  } else if (!inner && value?.type === 'PayingForTx' && value.version === 1) {
    encodedTx = buildTx({
      tag: Tag.PayingForTx,
      version: 1,
      payerId: value.payerId,
      nonce: value.nonce,
      fee: value.fee,
      tx: signedWalletTransactionFromNode(value.tx, true),
    });
  } else throw new Error('Unsupported wallet envelope');
  return buildTx({
    tag: Tag.SignedTx,
    encodedTx,
    signatures: [decode(transaction.signatures[0])],
  });
}

/** Read-only canonical proof shared by the signer and HTTP sponsorship status path. */
export async function observeSponsoredLike(
  node: any,
  rawOuter: string,
  rawInner: string,
  expected: {
    actor: string;
    contract: string;
    network: string;
    payer: string;
    policy: LikeSponsorshipPolicy;
  },
) {
  const identity = sponsoredLikeTransaction(rawOuter, rawInner, expected);
  const base = {
    tx: identity.innerHash,
    address: expected.actor,
    contract: expected.contract,
    network: expected.network,
    confirmationsRequired: 3,
    method: 'like',
    videoId: identity.videoId,
    amount: '0',
    nonce: identity.nonce,
    args: [identity.videoId, identity.version],
    sponsored: true,
    sponsoredTx: identity.outerHash,
  };
  if ((await node.getStatus()).networkId !== expected.network)
    throw new Error('Sponsor node network changed');
  let transaction;
  try {
    transaction = await node.getTransactionByHash(identity.outerHash);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      error.statusCode === 404
    )
      return { ...base, status: 'unknown', confirmations: 0 };
    throw error;
  }
  if (
    transaction.hash !== identity.outerHash ||
    signedWalletTransactionFromNode(transaction) !== rawOuter
  ) {
    throw new ServiceUnavailableException(
      'Sponsor transaction identity changed',
    );
  }
  if (transaction.blockHeight === -1 && transaction.blockHash === 'none') {
    return { ...base, status: 'submitted', confirmations: 0 };
  }
  const height = transaction.blockHeight;
  receiptHash(transaction.blockHash, 'mh_');
  const before = await node.getCurrentKeyBlock();
  receiptHash(before.hash, 'kh_');
  if (
    !Number.isSafeInteger(height) ||
    height < 0 ||
    !Number.isSafeInteger(before.height) ||
    before.height < height
  )
    throw new Error('Invalid sponsored block height');
  const generation = await node.getGenerationByHeight(height);
  receiptHash(generation.keyBlock.hash, 'kh_');
  if (
    generation.keyBlock.height !== height ||
    !Array.isArray(generation.microBlocks)
  )
    throw new Error('Invalid sponsored generation');
  const anchor = { blockHash: transaction.blockHash, blockHeight: height };
  if (!generation.microBlocks.includes(transaction.blockHash))
    return { ...base, ...anchor, status: 'reorged', confirmations: 0 };
  const info = (await node.getTransactionInfoByHash(identity.outerHash))
    ?.callInfo;
  if (
    !info ||
    info.callerId !== expected.actor ||
    info.contractId !== expected.contract ||
    info.callerNonce !== identity.nonce ||
    info.height !== height ||
    !['ok', 'revert', 'error'].includes(info.returnType)
  ) {
    throw new Error('Invalid sponsored execution evidence');
  }
  const [after, current, status] = await Promise.all([
    node.getCurrentKeyBlock(),
    node.getGenerationByHeight(height),
    node.getStatus(),
  ]);
  if (
    status.networkId !== expected.network ||
    before.hash !== after.hash ||
    before.height !== after.height ||
    current.keyBlock.height !== height ||
    current.keyBlock.hash !== generation.keyBlock.hash ||
    !current.microBlocks.includes(transaction.blockHash)
  )
    throw new Error('Sponsored confirmation changed');
  const confirmations = before.height - height + 1;
  return {
    ...base,
    ...anchor,
    confirmations,
    result: info.returnType,
    status:
      confirmations < 3
        ? 'mined'
        : info.returnType === 'ok'
          ? 'confirmed'
          : 'failed',
  };
}

/**
 * Testnet recovery uses the same three-key-block depth as successful receipts.
 * Never infer absence from a timeout. A consumed payer nonce needs manual reconciliation.
 */
export async function proveSponsoredLikeExpiry(
  node: any,
  expected: {
    outerHash: string;
    ttl: number;
    payer: string;
    payerNonce: number;
    network: string;
    allowNonceGap?: boolean;
  },
  saved?: {
    ttl: number;
    height: number;
    blockHash: string;
    payerNonce: number;
    reservedNonce?: number;
  },
) {
  if (
    !Number.isSafeInteger(expected.ttl) ||
    expected.ttl <= 0 ||
    !Number.isSafeInteger(expected.payerNonce) ||
    expected.payerNonce <= 0
  )
    throw new Error('Invalid expiry identity');
  if ((await node.getStatus()).networkId !== expected.network)
    throw new Error('Expiry node network changed');
  const before = await node.getCurrentKeyBlock();
  receiptHash(before.hash, 'kh_');
  if (!Number.isSafeInteger(before.height) || before.height < expected.ttl + 3)
    return undefined;
  const anchor = saved
    ? { height: saved.height, hash: saved.blockHash }
    : before;
  receiptHash(anchor.hash, 'kh_');
  if (
    !Number.isSafeInteger(anchor.height) ||
    anchor.height < expected.ttl + 3 ||
    anchor.height > before.height ||
    (saved &&
      (saved.ttl !== expected.ttl ||
        (saved.reservedNonce === undefined
          ? saved.payerNonce !== expected.payerNonce - 1
          : !expected.allowNonceGap ||
            saved.reservedNonce !== expected.payerNonce ||
            saved.payerNonce >= expected.payerNonce)))
  )
    return undefined;
  const unconsumed = (nonce: number) =>
    Number.isSafeInteger(nonce) &&
    nonce >= 0 &&
    (expected.allowNonceGap
      ? nonce < expected.payerNonce
      : nonce === expected.payerNonce - 1);
  const absent = async () => {
    try {
      const tx = await node.getTransactionByHash(expected.outerHash);
      if (tx.hash !== expected.outerHash)
        throw new Error('Expiry transaction identity changed');
      if (
        tx.blockHeight === -1 ||
        !Number.isSafeInteger(tx.blockHeight) ||
        tx.blockHeight < 0
      )
        return false;
      receiptHash(tx.blockHash, 'mh_');
      const generation = await node.getGenerationByHeight(tx.blockHeight);
      if (
        generation.keyBlock.height !== tx.blockHeight ||
        !Array.isArray(generation.microBlocks)
      )
        throw new Error('Invalid expiry generation');
      return !generation.microBlocks.includes(tx.blockHash);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'statusCode' in error &&
        error.statusCode === 404
      )
        return true;
      throw error;
    }
  };
  if (!(await absent())) return undefined;
  const atAnchor = await node.getAccountByPubkeyAndHash(
    expected.payer,
    anchor.hash,
  );
  const latest = await node.getAccountByPubkey(expected.payer);
  if (
    atAnchor.kind !== 'basic' ||
    !unconsumed(atAnchor.nonce) ||
    (saved && atAnchor.nonce !== saved.payerNonce) ||
    (!saved && (latest.kind !== 'basic' || !unconsumed(latest.nonce)))
  )
    return undefined;
  const [after, canonicalAnchor, currentPayer, status, stillAbsent] =
    await Promise.all([
      node.getCurrentKeyBlock(),
      node.getKeyBlockByHeight(anchor.height),
      node.getAccountByPubkey(expected.payer),
      node.getStatus(),
      absent(),
    ]);
  if (
    status.networkId !== expected.network ||
    before.hash !== after.hash ||
    before.height !== after.height ||
    canonicalAnchor.hash !== anchor.hash ||
    canonicalAnchor.height !== anchor.height ||
    (!saved &&
      (currentPayer.kind !== 'basic' || !unconsumed(currentPayer.nonce))) ||
    !stillAbsent
  )
    return undefined;
  return {
    ttl: expected.ttl,
    height: anchor.height,
    blockHash: anchor.hash,
    payerNonce: atAnchor.nonce,
    ...(expected.allowNonceGap ? { reservedNonce: expected.payerNonce } : {}),
  };
}
