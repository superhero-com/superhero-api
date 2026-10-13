import { sanitizeJsonForPostgres } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { decode } from '@aeternity/aepp-sdk';
import { Tx } from '../entities/tx.entity';

/**
 * Converts a camel-cased middleware transaction into a `txs` row.
 */
export function toMdwTx(tx: ITransaction): Partial<Tx> {
  let payload = '';
  if (tx?.tx?.type === 'SpendTx' && tx?.tx?.payload) {
    payload = decode(tx?.tx?.payload).toString();
  }

  // Sanitize JSONB fields to remove null bytes and invalid Unicode characters
  // PostgreSQL cannot handle null bytes (\u0000) in JSONB columns
  const sanitizedRaw = tx.tx ? sanitizeJsonForPostgres(tx.tx) : null;
  const sanitizedSignatures = tx.signatures
    ? sanitizeJsonForPostgres(tx.signatures)
    : [];

  return {
    hash: tx.hash,
    block_height: tx.blockHeight,
    block_hash: tx.blockHash?.toString() || '',
    micro_index: tx.microIndex?.toString() || '0',
    micro_time: tx.microTime?.toString() || '0',
    signatures: sanitizedSignatures,
    encoded_tx: tx.encodedTx || '',
    type: tx.tx?.type || '',
    contract_id: tx.tx?.contractId,
    function: tx.tx?.function,
    caller_id: tx.tx?.callerId,
    sender_id: tx.tx?.senderId,
    recipient_id: tx.tx?.recipientId,
    payload: payload ? sanitizeJsonForPostgres(payload) : '',
    raw: sanitizedRaw,
    version: 1,
    created_at: new Date(tx.microTime),
  };
}
