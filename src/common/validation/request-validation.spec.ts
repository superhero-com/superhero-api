import { BadRequestException } from '@nestjs/common';
import { Encoding, encode } from '@aeternity/aepp-sdk';
import {
  AeAccountAddressPipe,
  AeAccountReferencePipe,
  AeContractAddressPipe,
  AeTransactionHashPipe,
  OpaqueIdPipe,
} from './request-validation';

describe('request validation pipes', () => {
  const accountAddress =
    'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';
  const contractAddress = encode(Buffer.alloc(32, 1), Encoding.ContractAddress);
  const txHash = encode(Buffer.alloc(32, 2), Encoding.TxHash);

  it('rejects numeric account path values before downstream balance lookups', () => {
    expect(() =>
      new AeAccountReferencePipe().transform('100', { data: 'address' }),
    ).toThrow(BadRequestException);
  });

  it('accepts account addresses and .chain account references', () => {
    const pipe = new AeAccountReferencePipe();

    expect(pipe.transform(accountAddress, { data: 'address' })).toBe(
      accountAddress,
    );
    expect(pipe.transform('alice.chain', { data: 'address' })).toBe(
      'alice.chain',
    );
  });

  it('keeps strict account, contract, and transaction hash params separate', () => {
    expect(
      new AeAccountAddressPipe().transform(accountAddress, { data: 'address' }),
    ).toBe(accountAddress);
    expect(
      new AeContractAddressPipe().transform(contractAddress, {
        data: 'address',
      }),
    ).toBe(contractAddress);
    expect(
      new AeTransactionHashPipe().transform(txHash, { data: 'txHash' }),
    ).toBe(txHash);
  });

  it('allows generated post slug characters in opaque IDs', () => {
    const pipe = new OpaqueIdPipe();

    expect(pipe.transform('olá~mundo-abc123', { data: 'id' })).toBe(
      'olá~mundo-abc123',
    );
    expect(() => pipe.transform('../secret', { data: 'id' })).toThrow(
      BadRequestException,
    );
  });
});
