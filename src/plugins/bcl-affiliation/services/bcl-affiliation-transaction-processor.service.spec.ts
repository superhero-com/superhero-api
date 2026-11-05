import { BclAffiliationTransactionProcessorService } from './bcl-affiliation-transaction-processor.service';

describe('BclAffiliationTransactionProcessorService', () => {
  const setup = () => {
    const invitationRepository = { manager: { transaction: jest.fn() } };
    const eventEmitter = { emit: jest.fn() };
    const service = new BclAffiliationTransactionProcessorService(
      invitationRepository as any,
      eventEmitter as any,
    );
    return { service, invitationRepository, eventEmitter };
  };

  const redeemTx = {
    hash: 'th_redeem',
    function: 'redeem_invitation_code',
    raw: { result: 'ok' },
  } as any;

  it('rethrows when the invitation transaction fails, so the tx is parked', async () => {
    const { service, invitationRepository, eventEmitter } = setup();
    invitationRepository.manager.transaction.mockRejectedValue(
      new Error('timeout exceeded when trying to connect'),
    );

    await expect(
      service.processTransaction(redeemTx, 'live' as any),
    ).rejects.toThrow('timeout exceeded when trying to connect');
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('skips a call that did not succeed on chain', async () => {
    const { service, invitationRepository } = setup();

    await expect(
      service.processTransaction(
        { ...redeemTx, raw: { result: 'error' } },
        'live' as any,
      ),
    ).resolves.toBeNull();
    expect(invitationRepository.manager.transaction).not.toHaveBeenCalled();
  });
});
