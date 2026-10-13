import { BadRequestException } from '@nestjs/common';
import { Encoding, encode } from '@aeternity/aepp-sdk';
import {
  AeAccountAddressPipe,
  AeAccountReferencePipe,
  AeContractAddressPipe,
  AeTransactionHashPipe,
  OpaqueIdPipe,
  TopicParamPipe,
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
    for (const name of [
      'alice.chain',
      'Alice.CHAIN',
      // The same name in unicode and punycode; the node resolves either.
      '中文.chain',
      'xn--fiq228c.chain',
      // Active mainnet names, spelled as the middleware lists them.
      'ﬂ.chain',
      '\u200b铃兰.chain',
    ]) {
      expect(pipe.transform(name, { data: 'address' })).toBe(name);
    }
  });

  it('rejects names that only validate because URL parsing rewrites them', () => {
    const pipe = new AeAccountReferencePipe();

    for (const name of [
      '.chain',
      'ali\nce.chain',
      'ali\tce.chain',
      '%41lice.chain',
      '中 文.chain',
      '🦸.chain',
      'alice.test',
    ]) {
      expect(() => pipe.transform(name, { data: 'address' })).toThrow(
        BadRequestException,
      );
    }
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

  describe('TopicParamPipe', () => {
    const pipe = new TopicParamPipe();

    it('accepts topics in the scripts the token collections allow', () => {
      // GET /api/topics/name/%D8%A3%D9%86%D8%A7
      expect(pipe.transform('أنا', { data: 'name' })).toBe('أنا');
      expect(pipe.transform('汉字', { data: 'name' })).toBe('汉字');
      expect(pipe.transform('ПРИВЕТ', { data: 'name' })).toBe('ПРИВЕТ');
      expect(pipe.transform('привет', { data: 'name' })).toBe('привет');
    });

    it('still accepts the Latin topics it always did', () => {
      expect(pipe.transform('WORDS-1', { data: 'name' })).toBe('WORDS-1');
      expect(pipe.transform('some topic_name.v2', { data: 'name' })).toBe(
        'some topic_name.v2',
      );
    });

    it('keeps rejecting traversal and separator characters', () => {
      for (const value of ['../secret', 'a/b', 'a\\b', '.hidden', '-lead']) {
        expect(() => pipe.transform(value, { data: 'name' })).toThrow(
          BadRequestException,
        );
      }
    });

    it('rejects an empty or over-long topic', () => {
      expect(() => pipe.transform('', { data: 'name' })).toThrow(
        BadRequestException,
      );
      expect(() => pipe.transform('汉'.repeat(129), { data: 'name' })).toThrow(
        BadRequestException,
      );
    });
  });
});
