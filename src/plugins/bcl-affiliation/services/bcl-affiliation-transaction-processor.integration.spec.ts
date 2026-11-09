import 'dotenv/config';
import { Invitation } from '@/affiliation/entities/invitation.entity';
import { SyncDirectionEnum } from '@/mdw-sync/types/sync-direction';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { INVITATION_CLAIMED_EVENT } from '../events';
import { BclAffiliationTransactionProcessorService } from './bcl-affiliation-transaction-processor.service';

/**
 * What each affiliation call writes to `invitations`, against real Postgres.
 * Skipped when no DB host is set.
 */
const d = process.env.DB_HOST ? describe : describe.skip;

d('BclAffiliationTransactionProcessorService (integration)', () => {
  let db: IsolatedDb;
  let service: BclAffiliationTransactionProcessorService;
  let eventEmitter: { emit: jest.Mock };

  const INVITER = 'ak_inviter';
  const CODE_A = 'ak_code_a';
  const CODE_B = 'ak_code_b';
  const INVITEE = 'ak_invitee';
  const AE = '1000000000000000000';

  const call = (
    fn: string,
    args: unknown[],
    {
      hash = `th_${fn}`,
      caller = INVITER,
      microTime = 1700000000000,
      result = 'ok',
    } = {},
  ) =>
    ({
      hash,
      function: fn,
      caller_id: caller,
      block_height: 1234,
      micro_time: String(microTime),
      raw: { result, arguments: args },
    }) as any;

  const address = (value: string) => ({ type: 'address', value });
  const int = (value: string) => ({ type: 'int', value });

  const register = (codes: string[], amount = AE, options = {}) =>
    call(
      'register_invitation_code',
      [{ type: 'list', value: codes.map(address) }, int('0'), int(amount)],
      options,
    );
  const redeem = (code: string, invitee = INVITEE, options = {}) =>
    call('redeem_invitation_code', [address(invitee)], {
      caller: code,
      hash: 'th_redeem',
      microTime: 1700000500000,
      ...options,
    });
  const revoke = (code: string, options = {}) =>
    call('revoke_invitation_code', [address(code)], {
      hash: 'th_revoke',
      microTime: 1700000900000,
      ...options,
    });

  const apply = (tx: any, direction = SyncDirectionEnum.Live) =>
    service.processTransaction(tx, direction);

  const rows = () =>
    db.dataSource
      .getRepository(Invitation)
      .find({ order: { receiver_address: 'ASC' } });

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [Invitation],
      migrations: [],
    });
    await db.dataSource.synchronize();
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.dataSource.query('TRUNCATE invitations RESTART IDENTITY');
    eventEmitter = { emit: jest.fn() };
    service = new BclAffiliationTransactionProcessorService(
      db.dataSource.getRepository(Invitation),
      eventEmitter as any,
    );
    jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
  });

  describe('register_invitation_code', () => {
    it('creates one pending invitation per code, with the amount in AE and the chain time', async () => {
      const saved = await apply(
        register([CODE_A, CODE_B], '2500000000000000000'),
      );

      expect(saved).toHaveLength(2);
      expect(await rows()).toEqual([
        expect.objectContaining({
          tx_hash: 'th_register_invitation_code',
          block_height: 1234,
          sender_address: INVITER,
          receiver_address: CODE_A,
          amount: '2.5',
          status: 'pending',
          invitee_address: null,
          created_at: new Date(1700000000000),
        }),
        expect.objectContaining({ receiver_address: CODE_B, amount: '2.5' }),
      ]);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('is idempotent when the same call is replayed', async () => {
      const first = await apply(register([CODE_A, CODE_B]));
      const replay = await apply(
        register([CODE_A, CODE_B]),
        SyncDirectionEnum.Backward,
      );

      expect(replay.map(({ id }) => id)).toEqual(first.map(({ id }) => id));
      expect(await rows()).toHaveLength(2);
    });

    it('ignores list entries that are not addresses', async () => {
      await apply(
        call('register_invitation_code', [
          { type: 'list', value: [address(CODE_A), int('5')] },
          int('0'),
          int(AE),
        ]),
      );

      expect((await rows()).map((row) => row.receiver_address)).toEqual([
        CODE_A,
      ]);
    });

    it('stores a zero amount when the call carries none', async () => {
      await apply(
        call('register_invitation_code', [
          { type: 'list', value: [address(CODE_A)] },
        ]),
      );

      expect(await rows()).toEqual([
        expect.objectContaining({ receiver_address: CODE_A, amount: '0' }),
      ]);
    });

    it('writes nothing when the call has no code list', async () => {
      await expect(
        apply(call('register_invitation_code', [])),
      ).resolves.toEqual([]);
      expect(await rows()).toEqual([]);
    });
  });

  describe('redeem_invitation_code', () => {
    beforeEach(async () => {
      await apply(register([CODE_A, CODE_B]));
    });

    it('marks the code claimed by the invitee and announces it to the inviter', async () => {
      const [updated] = await apply(redeem(CODE_A));

      expect(updated).toMatchObject({
        receiver_address: CODE_A,
        status: 'claimed',
        invitee_address: INVITEE,
        claim_tx_hash: 'th_redeem',
        status_updated_at: new Date(1700000500000),
      });
      expect(await rows()).toEqual([
        expect.objectContaining({
          receiver_address: CODE_A,
          status: 'claimed',
        }),
        expect.objectContaining({
          receiver_address: CODE_B,
          status: 'pending',
        }),
      ]);
      expect(eventEmitter.emit).toHaveBeenCalledWith(INVITATION_CLAIMED_EVENT, {
        invitationId: updated.id,
        inviterAddress: INVITER,
        claimerAddress: CODE_A,
        amountAe: '1',
        txHash: 'th_redeem',
      });
    });

    it('records a backfilled claim without announcing it', async () => {
      await apply(redeem(CODE_A), SyncDirectionEnum.Backward);

      expect((await rows())[0]).toMatchObject({ status: 'claimed' });
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it.each([
      ['comes from an unknown code', () => redeem('ak_unknown')],
      [
        'has no invitee',
        () =>
          call('redeem_invitation_code', [], {
            caller: CODE_A,
            hash: 'th_redeem',
          }),
      ],
      ['failed on chain', () => redeem(CODE_A, INVITEE, { result: 'revert' })],
    ])('changes nothing when the call %s', async (_label, tx) => {
      const before = await rows();

      await expect(apply(tx())).resolves.toBeNull();

      expect(await rows()).toEqual(before);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('revoke_invitation_code', () => {
    beforeEach(async () => {
      await apply(register([CODE_A, CODE_B]));
    });

    it('marks only the revoked code revoked', async () => {
      const [updated] = await apply(revoke(CODE_A));

      expect(updated).toMatchObject({
        receiver_address: CODE_A,
        status: 'revoked',
        invitee_address: null,
        revoke_tx_hash: 'th_revoke',
        status_updated_at: new Date(1700000900000),
      });
      expect((await rows())[1]).toMatchObject({
        receiver_address: CODE_B,
        status: 'pending',
        revoke_tx_hash: null,
      });
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it.each([
      ['names an unknown code', () => revoke('ak_unknown')],
      [
        'names no code',
        () => call('revoke_invitation_code', [], { hash: 'th_revoke' }),
      ],
    ])('changes nothing when the call %s', async (_label, tx) => {
      const before = await rows();

      await expect(apply(tx())).resolves.toBeNull();

      expect(await rows()).toEqual(before);
    });
  });
});
