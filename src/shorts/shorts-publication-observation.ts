import type { Node } from '@aeternity/aepp-sdk';
import { receiptHash } from './shorts-receipts.service';
import {
  PublicationIntent,
  publicationCalldata,
} from './shorts-publication-transaction';

export async function publicationHead(node: Node, network: string) {
  if ((await node.getStatus()).networkId !== network)
    throw new Error('Publisher network changed');
  const head = await node.getCurrentKeyBlock();
  receiptHash(head.hash, 'kh_');
  if (!Number.isSafeInteger(head.height) || head.height < 0)
    throw new Error('Invalid node height');
  return head;
}

export async function publicationGeneration(node: Node, height: number) {
  const generation = await node.getGenerationByHeight(height);
  receiptHash(generation.keyBlock.hash, 'kh_');
  if (
    generation.keyBlock.height !== height ||
    !Array.isArray(generation.microBlocks)
  )
    throw new Error('Invalid canonical generation');
  for (const hash of generation.microBlocks) receiptHash(hash, 'mh_');
  return generation;
}

/** Verify the journaled call and its execution on the canonical chain at the requested depth. */
export async function observePublication(
  node: Node,
  expected: {
    network: string;
    contract: string;
    operator: string;
    transactionHash: string;
    intent: PublicationIntent;
    nonce?: number;
  },
  depth: number,
) {
  receiptHash(expected.transactionHash, 'th_');
  const tip = await publicationHead(node, expected.network);
  let tx: Awaited<ReturnType<Node['getTransactionByHash']>>;
  try {
    tx = await node.getTransactionByHash(expected.transactionHash);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      error.statusCode === 404
    )
      return { state: 'absent' as const };
    throw error;
  }
  if (
    tx.hash !== expected.transactionHash ||
    tx.tx.type !== 'ContractCallTx' ||
    tx.tx.callerId !== expected.operator ||
    tx.tx.contractId !== expected.contract ||
    !Number.isSafeInteger(tx.tx.nonce) ||
    tx.tx.nonce < 1 ||
    (expected.nonce !== undefined && tx.tx.nonce !== expected.nonce) ||
    tx.tx.callData !== publicationCalldata(expected.intent) ||
    BigInt(tx.tx.amount) !== 0n
  )
    throw new Error('Node returned a conflicting publication transaction');
  if (tx.blockHeight === -1) return { state: 'pending' as const };
  receiptHash(tx.blockHash, 'mh_');
  if (!Number.isSafeInteger(tx.blockHeight) || tx.blockHeight < 0)
    throw new Error('Invalid transaction height');
  if (tip.height - tx.blockHeight < depth) return { state: 'pending' as const };
  const [generation, info, block] = await Promise.all([
    publicationGeneration(node, tx.blockHeight),
    node.getTransactionInfoByHash(expected.transactionHash),
    node.getMicroBlockTransactionsByHash(tx.blockHash),
  ]);
  const call = info.callInfo;
  if (
    !generation.microBlocks.includes(tx.blockHash) ||
    !block.transactions.some((t) => t.hash === expected.transactionHash) ||
    !call ||
    call.callerId !== expected.operator ||
    call.contractId !== expected.contract ||
    call.callerNonce !== tx.tx.nonce ||
    call.height !== tx.blockHeight ||
    !['ok', 'error', 'revert'].includes(call.returnType)
  )
    throw new Error('Publication receipt is not canonical');
  const stable = await publicationGeneration(node, tx.blockHeight);
  const after = await publicationHead(node, expected.network);
  if (
    stable.keyBlock.hash !== generation.keyBlock.hash ||
    !stable.microBlocks.includes(tx.blockHash) ||
    after.height - tx.blockHeight < depth
  )
    throw new Error('Publication confirmation changed');
  return {
    state: 'settled' as const,
    proof: {
      transactionHash: expected.transactionHash,
      blockHash: tx.blockHash,
      height: tx.blockHeight,
      tipHeight: after.height,
      result: call.returnType,
    },
  };
}
