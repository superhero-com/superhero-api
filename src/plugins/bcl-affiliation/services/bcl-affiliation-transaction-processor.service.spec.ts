import { SyncDirectionEnum } from '@/mdw-sync/types/sync-direction';
import { INVITATION_CLAIMED_EVENT } from '../events';
import { BclAffiliationTransactionProcessorService } from './bcl-affiliation-transaction-processor.service';

/**
 * Gating and post-commit event behaviour. The SQL side (what each call writes)
 * is covered against real Postgres in the integration spec next to this file.
 */
describe('BclAffiliationTransactionProcessorService', () => {
  const setup = () => {
    const repo = { findOne: jest.fn(), save: jest.fn(), update: jest.fn() };
    const manager = { getRepository: jest.fn(() => repo) };
    const log: string[] = [];
    const invitationRepository = {
      manager: {
        transaction: jest.fn(async (work: (m: typeof manager) => unknown) => {
          const result = await work(manager);
          log.push('commit');
          return result;
        }),
      },
    };
    const eventEmitter = {
      emit: jest.fn((name: string) => {
        log.push(`emit ${name}`);
      }),
    };
    const service = new BclAffiliationTransactionProcessorService(
      invitationRepository as any,
      eventEmitter as any,
    );
    jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    return { service, repo, invitationRepository, eventEmitter, log };
  };

  const redeemTx = {
    hash: 'th_redeem',
    function: 'redeem_invitation_code',
    caller_id: 'ak_code',
    micro_time: '1700000000000',
    raw: {
      result: 'ok',
      arguments: [{ type: 'address', value: 'ak_invitee' }],
    },
  } as any;

  const claimed = {
    id: '7',
    sender_address: 'ak_inviter',
    receiver_address: 'ak_code',
    amount: '2.5',
    status: 'claimed',
  };

  it('rethrows when the invitation transaction fails, so the tx is parked', async () => {
    const { service, invitationRepository, eventEmitter } = setup();
    invitationRepository.manager.transaction.mockRejectedValue(
      new Error('timeout exceeded when trying to connect'),
    );

    await expect(
      service.processTransaction(redeemTx, SyncDirectionEnum.Live),
    ).rejects.toThrow('timeout exceeded when trying to connect');
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it.each([
    ['did not succeed on chain', { raw: { result: 'error' } }],
    ['has no function name', { function: undefined }],
  ])('skips a call that %s', async (_label, overrides) => {
    const { service, invitationRepository } = setup();

    await expect(
      service.processTransaction(
        { ...redeemTx, ...overrides },
        SyncDirectionEnum.Live,
      ),
    ).resolves.toBeNull();
    expect(invitationRepository.manager.transaction).not.toHaveBeenCalled();
  });

  it('ignores other affiliation functions without writing or emitting', async () => {
    const { service, repo, eventEmitter } = setup();

    await expect(
      service.processTransaction(
        { ...redeemTx, function: 'register_invitation' },
        SyncDirectionEnum.Live,
      ),
    ).resolves.toBeNull();
    expect(repo.findOne).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('announces a live claim to the inviter only after the transaction commits', async () => {
    const { service, repo, eventEmitter, log } = setup();
    repo.findOne.mockResolvedValue(claimed);

    await expect(
      service.processTransaction(redeemTx, SyncDirectionEnum.Live),
    ).resolves.toEqual([claimed]);

    expect(log).toEqual(['commit', `emit ${INVITATION_CLAIMED_EVENT}`]);
    expect(eventEmitter.emit).toHaveBeenCalledWith(INVITATION_CLAIMED_EVENT, {
      invitationId: '7',
      inviterAddress: 'ak_inviter',
      claimerAddress: 'ak_code',
      amountAe: '2.5',
      txHash: 'th_redeem',
    });
  });

  it.each([SyncDirectionEnum.Backward, SyncDirectionEnum.Reorg])(
    'records a %s claim without notifying anyone',
    async (direction) => {
      const { service, repo, eventEmitter } = setup();
      repo.findOne.mockResolvedValue(claimed);

      await expect(
        service.processTransaction(redeemTx, direction),
      ).resolves.toEqual([claimed]);
      expect(repo.update).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    },
  );

  it('does not announce a claim whose invitation has no inviter', async () => {
    const { service, repo, eventEmitter } = setup();
    repo.findOne.mockResolvedValue({ ...claimed, sender_address: null });

    await service.processTransaction(redeemTx, SyncDirectionEnum.Live);

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it("reports a zero amount when the invitation's amount is missing", async () => {
    const { service, repo, eventEmitter } = setup();
    repo.findOne.mockResolvedValue({ ...claimed, amount: null });

    await service.processTransaction(redeemTx, SyncDirectionEnum.Live);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      INVITATION_CLAIMED_EVENT,
      expect.objectContaining({ amountAe: '0' }),
    );
  });

  it('does not announce anything when the claimed code is unknown', async () => {
    const { service, repo, eventEmitter } = setup();
    repo.findOne.mockResolvedValue(null);

    await expect(
      service.processTransaction(redeemTx, SyncDirectionEnum.Live),
    ).resolves.toBeNull();
    expect(repo.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});
