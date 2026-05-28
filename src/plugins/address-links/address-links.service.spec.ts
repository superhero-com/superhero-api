import { BadRequestException } from '@nestjs/common';
import { AddressLinksService } from './address-links.service';
import { AddressLinksContractService } from './contract.service';

describe('AddressLinksService prefered AENS name', () => {
  const contractService = {
    getNoncePrincipal: jest.fn(),
    buildLinkMessageForPrincipal: jest.fn(),
    linkPrincipal: jest.fn(),
    getLink: jest.fn(),
    buildUnlinkMessageForPrincipal: jest.fn(),
    unlinkPrincipal: jest.fn(),
  };

  const service = new AddressLinksService(
    contractService as unknown as AddressLinksContractService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds principal-based link claim messages', async () => {
    contractService.getNoncePrincipal.mockResolvedValue(2);
    contractService.buildLinkMessageForPrincipal.mockReturnValue(
      'link:hero.chain:prefaens:hero.chain:2',
    );

    const result = await service.claimLinkPrincipal(
      'ak_signer',
      'prefaens',
      'hero.chain',
      'hero.chain',
    );

    expect(contractService.getNoncePrincipal).toHaveBeenCalledWith(
      'hero.chain',
      'ak_signer',
    );
    expect(result).toEqual({
      message: 'link:hero.chain:prefaens:hero.chain:2',
      nonce: 2,
      value: 'hero.chain',
      principal: 'hero.chain',
    });
  });

  it('submits link_principal transactions', async () => {
    contractService.linkPrincipal.mockResolvedValue({ hash: 'th_123' });

    const result = await service.submitLinkPrincipal(
      'ak_signer',
      'prefaens',
      'hero.chain',
      'hero.chain',
      2,
      'a'.repeat(128),
    );

    expect(contractService.linkPrincipal).toHaveBeenCalledWith(
      'hero.chain',
      'ak_signer',
      'prefaens',
      'hero.chain',
      2,
      'a'.repeat(128),
    );
    expect(result).toEqual({ txHash: 'th_123' });
  });

  it('builds principal-based unlink claim messages from the current link', async () => {
    contractService.getLink.mockResolvedValue('hero.chain');
    contractService.getNoncePrincipal.mockResolvedValue(3);
    contractService.buildUnlinkMessageForPrincipal.mockReturnValue(
      'unlink:hero.chain:prefaens:3',
    );

    const result = await service.claimUnlinkPrincipal('ak_signer', 'prefaens');

    expect(result).toEqual({
      message: 'unlink:hero.chain:prefaens:3',
      nonce: 3,
      value: 'hero.chain',
      principal: 'hero.chain',
    });
  });

  it('rejects unlink claim when no link exists', async () => {
    contractService.getLink.mockResolvedValue(null);

    await expect(
      service.claimUnlinkPrincipal('ak_signer', 'prefaens'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
