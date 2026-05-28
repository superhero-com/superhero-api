import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { decode } from '@aeternity/aepp-sdk';
import { SyncDirectionEnum } from '@/mdw-sync/types/sync-direction';
import { AddressLinksPluginSyncService } from './address-links-plugin-sync.service';
import { Account } from '@/account/entities/account.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { ProfileCacheService } from '@/profile/services/profile-cache.service';
import { ProfileXPostingRewardService } from '@/profile/services/profile-x-posting-reward.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';

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
        arguments: [
          { name: 'principal', value: 'hero.chain' },
          { name: 'signer', value: SIGNER_ADDRESS },
          { name: 'provider', value: 'prefaens' },
          { name: 'value', value: 'hero.chain' },
        ],
      },
      ...overrides,
    }) as Tx;

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
          arguments: [
            { name: 'principal', value: 'hero.chain' },
            { name: 'signer', value: SIGNER_ADDRESS },
            { name: 'provider', value: 'prefaens' },
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
      baseTx({ function: 'link', hash: 'th_link' }),
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
});
