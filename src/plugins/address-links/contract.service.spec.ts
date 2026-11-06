import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AddressLinksContractService } from './contract.service';

describe('AddressLinksContractService', () => {
  let service: AddressLinksContractService;
  let fakeContract: Record<string, jest.Mock>;

  beforeEach(() => {
    service = new AddressLinksContractService({} as any);
    fakeContract = {
      get_nonce: jest.fn(),
      get_nonce_principal: jest.fn(),
      get_link: jest.fn(),
      link: jest.fn(),
      unlink: jest.fn(),
      link_principal: jest.fn(),
      unlink_principal: jest.fn(),
    };
    jest
      .spyOn(service as any, 'getContractInstance')
      .mockResolvedValue(fakeContract);
  });

  describe('getNonce', () => {
    it('surfaces a node/contract call failure as ServiceUnavailableException', async () => {
      fakeContract.get_nonce.mockRejectedValue(new Error('node timeout'));

      await expect(service.getNonce('ak_test')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('returns the decoded nonce on success', async () => {
      fakeContract.get_nonce.mockResolvedValue({ decodedResult: 5 });

      await expect(service.getNonce('ak_test')).resolves.toBe(5);
    });
  });

  describe('getNoncePrincipal', () => {
    it('surfaces a node/contract call failure as ServiceUnavailableException', async () => {
      fakeContract.get_nonce_principal.mockRejectedValue(
        new Error('node timeout'),
      );

      await expect(
        service.getNoncePrincipal('test.chain', 'ak_signer'),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('getLink', () => {
    it('surfaces a node/contract call failure as ServiceUnavailableException', async () => {
      fakeContract.get_link.mockRejectedValue(new Error('node timeout'));

      await expect(service.getLink('ak_test', 'x')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('returns null when no link exists', async () => {
      fakeContract.get_link.mockResolvedValue({ decodedResult: false });

      await expect(service.getLink('ak_test', 'x')).resolves.toBeNull();
    });
  });

  describe('write calls', () => {
    const providerAccount = { address: 'ak_provider' };
    const signature = 'ab'.repeat(64);

    beforeEach(() => {
      (service as any).providerAccount = providerAccount;
    });

    const writes: Array<
      [string, (sig: string) => Promise<unknown>, string, unknown[]]
    > = [
      [
        'link',
        (sig) => service.link('ak_alice', 'x', 'alice', 1, sig),
        'link',
        ['ak_alice', 'x', 'alice', 1],
      ],
      [
        'unlink',
        (sig) => service.unlink('ak_alice', 'x', 1, sig),
        'unlink',
        ['ak_alice', 'x', 1],
      ],
      [
        'linkPrincipal',
        (sig) =>
          service.linkPrincipal(
            'hero.chain',
            'ak_alice',
            'prefaens',
            'hero.chain',
            1,
            sig,
          ),
        'link_principal',
        ['hero.chain', 'ak_alice', 'prefaens', 'hero.chain', 1],
      ],
      [
        'unlinkPrincipal',
        (sig) =>
          service.unlinkPrincipal('hero.chain', 'ak_alice', 'prefaens', 1, sig),
        'unlink_principal',
        ['hero.chain', 'ak_alice', 'prefaens', 1],
      ],
    ];

    it.each(writes)(
      '%s sends from the provider wallet with the signature bytes',
      async (_, call, entrypoint, args) => {
        fakeContract[entrypoint].mockResolvedValue({ hash: 'th_1' });

        await expect(call(signature)).resolves.toEqual({ hash: 'th_1' });
        expect(fakeContract[entrypoint]).toHaveBeenCalledWith(
          ...args,
          Buffer.from(signature, 'hex'),
          { onAccount: providerAccount },
        );
      },
    );

    it.each(writes)(
      '%s refuses a signature that is not 64 bytes of hex',
      async (_, call, entrypoint) => {
        for (const bad of ['ab'.repeat(63), 'zz'.repeat(64)]) {
          await expect(call(bad)).rejects.toThrow(BadRequestException);
        }
        expect(fakeContract[entrypoint]).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['INVALID_SIGNATURE', 'Wallet signature verification failed'],
      ['INVALID_NONCE', 'Nonce mismatch'],
      ['NOT_PROVIDER_OWNER', 'The backend wallet is not the registered owner'],
    ])('turns a %s revert into a 400', async (code, message) => {
      fakeContract.link.mockRejectedValue(
        new Error(`Invocation failed: "${code}"`),
      );

      const result = service.link('ak_alice', 'x', 'alice', 1, signature);
      await expect(result).rejects.toThrow(BadRequestException);
      await expect(result).rejects.toThrow(message);
    });

    it('passes an unknown failure through unchanged', async () => {
      const failure = new Error('node unreachable');
      fakeContract.link.mockRejectedValue(failure);

      await expect(
        service.link('ak_alice', 'x', 'alice', 1, signature),
      ).rejects.toBe(failure);
    });
  });
});
