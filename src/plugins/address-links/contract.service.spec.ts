import { ServiceUnavailableException } from '@nestjs/common';
import { AddressLinksContractService } from './contract.service';

describe('AddressLinksContractService', () => {
  let service: AddressLinksContractService;
  let fakeContract: {
    get_nonce: jest.Mock;
    get_nonce_principal: jest.Mock;
    get_link: jest.Mock;
  };

  beforeEach(() => {
    service = new AddressLinksContractService({} as any);
    fakeContract = {
      get_nonce: jest.fn(),
      get_nonce_principal: jest.fn(),
      get_link: jest.fn(),
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
});
