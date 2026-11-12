/**
 * Preserve the mined outer hash but attribute a sponsored call to its signer.
 * Shorts supports one PayingForTx around a regular account ContractCallTx;
 * generalized accounts and recursively sponsored wrappers are not supported.
 */
export function shortsInnerContractCall(value: any): any | undefined {
  if (value?.type === 'ContractCallTx') return value;
  if (value?.type !== 'PayingForTx') return undefined;
  const inner = value.tx?.tx ?? value.tx;
  return inner?.type === 'ContractCallTx' ? inner : undefined;
}

/** Middleware rows store the outer transaction and its nested raw body. */
export function shortsIndexedContractCall(tx: {
  type?: string;
  raw?: any;
  caller_id?: string;
  contract_id?: string;
  function?: string;
}): any | undefined {
  if (tx.type === 'ContractCallTx') {
    return {
      ...tx.raw,
      type: tx.type,
      callerId: tx.caller_id,
      contractId: tx.contract_id,
      function: tx.function,
    };
  }
  if (tx.type !== 'PayingForTx' || tx.raw?.type !== tx.type) return undefined;
  return shortsInnerContractCall(tx.raw);
}
