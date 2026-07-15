import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { decode } from '@aeternity/aepp-sdk';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SyncDirectionEnum } from '@/mdw-sync/types/sync-direction';
import { AddressLinksPluginSyncService } from './address-links-plugin-sync.service';
import { Account } from '@/account/entities/account.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { ProfileCacheService } from '@/profile/services/profile-cache.service';
import { ProfileXPostingRewardService } from '@/profile/services/profile-x-posting-reward.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { TGR_LINK_CHANGED } from '@/token-gated-rooms/events';

const SIGNER_ADDRESS = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';
const SIGNER_ADDRESS_INT = BigInt(
  `0x${decode(SIGNER_ADDRESS).toString('hex')}`,
).toString();

describe('AddressLinksPluginSyncService', () => {
  let service: AddressLinksPluginSyncService;
  let accountRepo: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let queryBuilder: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orIgnore: jest.Mock;
    execute: jest.Mock;
    update: jest.Mock;
    set: jest.Mock;
    setParameter: jest.Mock;
    where: jest.Mock;
  };
  let profileCacheService: { syncFromAccountLinks: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    queryBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
    };

    accountRepo = {
      findOne: jest.fn().mockResolvedValue({ address: SIGNER_ADDRESS }),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };

    profileCacheService = {
      syncFromAccountLinks: jest.fn().mockResolvedValue(undefined),
    };

    eventEmitter = { emit: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AddressLinksPluginSyncService,
        { provide: AeSdkService, useValue: {} },
        {
          provide: getRepositoryToken(Account),
          useValue: accountRepo,
        },
        {
          provide: ProfileXPostingRewardService,
          useValue: {
            upsertVerifiedCandidateFromTx: jest.fn(),
          },
        },
        {
          provide: ProfileCacheService,
          useValue: profileCacheService,
        },
        {
          provide: EventEmitter2,
          useValue: eventEmitter,
        },
      ],
    }).compile();

    service = moduleRef.get(AddressLinksPluginSyncService);
  });

  const baseTx = (overrides: Partial<Tx> = {}): Tx =>
    ({
      hash: 'th_principal',
      micro_time: '1000',
      function: 'link_principal',
      raw: {
        // Middleware returns contract-call arguments positionally as
        // { type, value } with no `name` field, matching the ACI signature
        // link_principal(principal, signer, provider, value, nonce, sig).
        arguments: [
          { type: 'string', value: 'hero.chain' },
          { type: 'address', value: SIGNER_ADDRESS },
          { type: 'string', value: 'prefaens' },
          { type: 'string', value: 'hero.chain' },
        ],
      },
      ...overrides,
    }) as Tx;

  it('updates accounts.links from link call arguments without fetching logs', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    await service.processTransaction(
      baseTx({
        function: 'link',
        hash: 'th_link',
        raw: {
          // link(addr, provider, value, nonce, sig)
          arguments: [
            { type: 'address', value: SIGNER_ADDRESS },
            { type: 'string', value: 'site' },
            { type: 'string', value: 'www.wikipedia.org' },
            { type: 'int', value: '1' },
          ],
        },
      }),
      SyncDirectionEnum.Live,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(queryBuilder.setParameter).toHaveBeenCalledWith('provider', 'site');
    expect(queryBuilder.setParameter).toHaveBeenCalledWith(
      'value',
      'www.wikipedia.org',
    );
    expect(queryBuilder.where).toHaveBeenCalledWith('address = :address', {
      address: SIGNER_ADDRESS,
    });
    expect(profileCacheService.syncFromAccountLinks).toHaveBeenCalledWith(
      SIGNER_ADDRESS,
      '1000',
    );

    fetchSpy.mockRestore();
  });

  it('removes provider from accounts.links for unlink call arguments', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    await service.processTransaction(
      baseTx({
        function: 'unlink',
        hash: 'th_unlink',
        raw: {
          // unlink(addr, provider, nonce, sig)
          arguments: [
            { type: 'address', value: SIGNER_ADDRESS },
            { type: 'string', value: 'site' },
            { type: 'int', value: '1' },
          ],
        },
      }),
      SyncDirectionEnum.Live,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(queryBuilder.setParameter).toHaveBeenCalledWith('provider', 'site');
    expect(queryBuilder.where).toHaveBeenCalledWith('address = :address', {
      address: SIGNER_ADDRESS,
    });
    expect(profileCacheService.syncFromAccountLinks).toHaveBeenCalledWith(
      SIGNER_ADDRESS,
      '1000',
    );

    fetchSpy.mockRestore();
  });

  it('updates accounts.links from link_principal call arguments', async () => {
    await service.processTransaction(baseTx(), SyncDirectionEnum.Live);

    expect(queryBuilder.update).toHaveBeenCalled();
    expect(queryBuilder.setParameter).toHaveBeenCalledWith(
      'provider',
      'prefaens',
    );
    expect(queryBuilder.setParameter).toHaveBeenCalledWith(
      'value',
      'hero.chain',
    );
    expect(queryBuilder.where).toHaveBeenCalledWith('address = :address', {
      address: SIGNER_ADDRESS,
    });
    expect(profileCacheService.syncFromAccountLinks).toHaveBeenCalledWith(
      SIGNER_ADDRESS,
      '1000',
    );
  });

  it('removes provider from accounts.links for unlink_principal', async () => {
    await service.processTransaction(
      baseTx({
        function: 'unlink_principal',
        raw: {
          // unlink_principal(principal, signer, provider, nonce, sig)
          arguments: [
            { type: 'string', value: 'hero.chain' },
            { type: 'address', value: SIGNER_ADDRESS },
            { type: 'string', value: 'prefaens' },
          ],
        },
      }),
      SyncDirectionEnum.Live,
    );

    expect(queryBuilder.setParameter).toHaveBeenCalledWith(
      'provider',
      'prefaens',
    );
    expect(queryBuilder.where).toHaveBeenCalledWith('address = :address', {
      address: SIGNER_ADDRESS,
    });
    expect(profileCacheService.syncFromAccountLinks).toHaveBeenCalledWith(
      SIGNER_ADDRESS,
      '1000',
    );
  });

  it('falls back to named arguments when the middleware provides them', async () => {
    await service.processTransaction(
      baseTx({
        raw: {
          arguments: [
            { name: 'principal', type: 'string', value: 'hero.chain' },
            { name: 'value', type: 'string', value: 'hero.chain' },
            { name: 'provider', type: 'string', value: 'prefaens' },
            { name: 'signer', type: 'address', value: SIGNER_ADDRESS },
          ],
        },
      }),
      SyncDirectionEnum.Live,
    );

    expect(queryBuilder.setParameter).toHaveBeenCalledWith(
      'provider',
      'prefaens',
    );
    expect(queryBuilder.where).toHaveBeenCalledWith('address = :address', {
      address: SIGNER_ADDRESS,
    });
  });

  it('falls back to fetching logs when call arguments are missing', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    await service.processTransaction(
      baseTx({ raw: { arguments: [] } }),
      SyncDirectionEnum.Live,
    );

    expect(fetchSpy).toHaveBeenCalled();
    expect(queryBuilder.update).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('handles PrincipalLink logs by event_name', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            event_hash: 'unknown_hash',
            event_name: 'PrincipalLink',
            args: [SIGNER_ADDRESS_INT],
            data: 'prefaens:hero.chain',
          },
        ],
      }),
    } as Response);

    await service.processTransaction(
      // Empty call arguments force the log-fetch fallback, which is where
      // event_name resolution lives.
      baseTx({ function: 'link', hash: 'th_link', raw: { arguments: [] } }),
      SyncDirectionEnum.Live,
    );

    expect(fetchSpy).toHaveBeenCalled();
    expect(queryBuilder.setParameter).toHaveBeenCalledWith(
      'provider',
      'prefaens',
    );
    expect(queryBuilder.setParameter).toHaveBeenCalledWith(
      'value',
      'hero.chain',
    );

    fetchSpy.mockRestore();
  });

  describe('tgr.link.changed seam (Task 05)', () => {
    it('emits tgr.link.changed on a nostr link', async () => {
      await service.processTransaction(
        baseTx({
          function: 'link',
          hash: 'th_nostr_link',
          raw: {
            arguments: [
              { type: 'address', value: SIGNER_ADDRESS },
              { type: 'string', value: 'nostr' },
              { type: 'string', value: 'npub1abc' },
              { type: 'int', value: '1' },
            ],
          },
        }),
        SyncDirectionEnum.Live,
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(TGR_LINK_CHANGED, {
        address: SIGNER_ADDRESS,
      });
    });

    it('emits tgr.link.changed on a nostr unlink', async () => {
      await service.processTransaction(
        baseTx({
          function: 'unlink',
          hash: 'th_nostr_unlink',
          raw: {
            arguments: [
              { type: 'address', value: SIGNER_ADDRESS },
              { type: 'string', value: 'nostr' },
              { type: 'int', value: '1' },
            ],
          },
        }),
        SyncDirectionEnum.Live,
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(TGR_LINK_CHANGED, {
        address: SIGNER_ADDRESS,
      });
    });

    it('does NOT emit tgr.link.changed for a non-nostr provider', async () => {
      await service.processTransaction(
        baseTx({
          function: 'link',
          hash: 'th_site_link',
          raw: {
            arguments: [
              { type: 'address', value: SIGNER_ADDRESS },
              { type: 'string', value: 'site' },
              { type: 'string', value: 'www.wikipedia.org' },
              { type: 'int', value: '1' },
            ],
          },
        }),
        SyncDirectionEnum.Live,
      );

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
