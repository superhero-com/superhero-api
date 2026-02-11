import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { verifyMessage } from '@aeternity/aepp-sdk';
import { AccountService } from '@/account/services/account.service';
import { ProfileService } from './profile.service';
import { Profile } from '../entities/profile.entity';
import { ProfileUpdateChallenge } from '../entities/profile-update-challenge.entity';

jest.mock('@aeternity/aepp-sdk', () => ({
  verifyMessage: jest.fn(),
}));

const mockGetOwnedChainNames = jest.fn().mockResolvedValue([]);
jest.mock('@/account/services/account.service', () => ({
  AccountService: class {
    getOwnedChainNames = mockGetOwnedChainNames;
  },
}));

describe('ProfileService', () => {
  let service: ProfileService;
  let profileRepository: jest.Mocked<Repository<Profile>>;
  let challengeRepository: jest.Mocked<Repository<ProfileUpdateChallenge>>;

  const mockProfileRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockChallengeRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  beforeEach(async () => {
    mockGetOwnedChainNames.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfileService,
        {
          provide: getRepositoryToken(Profile),
          useValue: mockProfileRepository,
        },
        {
          provide: getRepositoryToken(ProfileUpdateChallenge),
          useValue: mockChallengeRepository,
        },
        {
          provide: AccountService,
          useValue: new (AccountService as unknown as new () => {
            getOwnedChainNames: typeof mockGetOwnedChainNames;
          })(),
        },
      ],
    }).compile();

    service = module.get<ProfileService>(ProfileService);
    profileRepository = module.get(getRepositoryToken(Profile));
    challengeRepository = module.get(
      getRepositoryToken(ProfileUpdateChallenge),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('issues challenge with payload hash and expiry', async () => {
    challengeRepository.save.mockResolvedValue({} as ProfileUpdateChallenge);

    const result = await service.issueUpdateChallenge(
      'ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi',
      {
        fullname: 'John Smith',
        bio: 'Builder',
      },
      '127.0.0.1',
      'jest',
    );

    expect(result.challenge).toContain('update_profile');
    expect(result.payload_hash).toHaveLength(64);
    expect(result.expires_at).toBeInstanceOf(Date);
    expect(challengeRepository.save).toHaveBeenCalled();
  });

  it('updates profile with valid challenge and signature', async () => {
    const now = Date.now();
    const challengeEntry: Partial<ProfileUpdateChallenge> = {
      id: 'c1',
      challenge: 'challenge-test',
      address: 'ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi',
      action: 'update_profile',
      expires_at: new Date(now + 60_000),
      consumed_at: null,
    };

    challengeRepository.findOne.mockResolvedValue(
      challengeEntry as ProfileUpdateChallenge,
    );
    (verifyMessage as jest.Mock).mockReturnValue(true);

    const queryBuilderMock = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    challengeRepository.createQueryBuilder.mockReturnValue(
      queryBuilderMock as any,
    );

    profileRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        address: challengeEntry.address,
        fullname: 'John',
      } as Profile);
    profileRepository.save.mockResolvedValue({} as Profile);

    const payload = {
      fullname: 'John',
      challenge: 'challenge-test',
      signature: 'abcdef123456',
    };
    // set hash that service expects for this payload
    const payloadHash = (service as any).createPayloadHash(
      challengeEntry.address,
      {
        fullname: 'John',
      },
    );
    (challengeEntry as any).payload_hash = payloadHash;

    const result = await service.updateProfileWithChallenge(
      challengeEntry.address!,
      payload as any,
      '127.0.0.1',
    );

    expect(result?.address).toEqual(challengeEntry.address);
    expect(queryBuilderMock.execute).toHaveBeenCalled();
  });

  it('rejects replay when atomic consume affects zero rows', async () => {
    const challengeEntry: Partial<ProfileUpdateChallenge> = {
      id: 'c2',
      challenge: 'challenge-replay',
      address: 'ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi',
      action: 'update_profile',
      expires_at: new Date(Date.now() + 60_000),
      consumed_at: null,
    };
    const payloadHash = (service as any).createPayloadHash(
      challengeEntry.address,
      {
        fullname: 'Replay',
      },
    );
    (challengeEntry as any).payload_hash = payloadHash;

    challengeRepository.findOne.mockResolvedValue(
      challengeEntry as ProfileUpdateChallenge,
    );
    (verifyMessage as jest.Mock).mockReturnValue(true);

    const queryBuilderMock = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    challengeRepository.createQueryBuilder.mockReturnValue(
      queryBuilderMock as any,
    );

    await expect(
      service.updateProfileWithChallenge(
        challengeEntry.address!,
        {
          fullname: 'Replay',
          challenge: challengeEntry.challenge!,
          signature: 'abcdef123456',
        },
        '127.0.0.1',
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects invalid signature', async () => {
    const challengeEntry: Partial<ProfileUpdateChallenge> = {
      id: 'c3',
      challenge: 'challenge-invalid-signature',
      address: 'ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi',
      action: 'update_profile',
      expires_at: new Date(Date.now() + 60_000),
      consumed_at: null,
    };
    const payloadHash = (service as any).createPayloadHash(
      challengeEntry.address,
      {
        fullname: 'Nope',
      },
    );
    (challengeEntry as any).payload_hash = payloadHash;

    challengeRepository.findOne.mockResolvedValue(
      challengeEntry as ProfileUpdateChallenge,
    );
    (verifyMessage as jest.Mock).mockReturnValue(false);

    await expect(
      service.updateProfileWithChallenge(
        challengeEntry.address!,
        {
          fullname: 'Nope',
          challenge: challengeEntry.challenge!,
          signature: 'abcdef123456',
        },
        '127.0.0.1',
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects expired challenge', async () => {
    const challengeEntry: Partial<ProfileUpdateChallenge> = {
      id: 'c4',
      challenge: 'challenge-expired',
      address: 'ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi',
      action: 'update_profile',
      expires_at: new Date(Date.now() - 60_000),
      consumed_at: null,
      payload_hash: 'dummy',
    };

    challengeRepository.findOne.mockResolvedValue(
      challengeEntry as ProfileUpdateChallenge,
    );

    await expect(
      service.updateProfileWithChallenge(
        challengeEntry.address!,
        {
          fullname: 'Expired',
          challenge: challengeEntry.challenge!,
          signature: 'abcdef123456',
        },
        '127.0.0.1',
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects duplicate username on challenge issue', async () => {
    const queryBuilderMock = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        address: 'ak_existing',
        username: 'taken_name',
      }),
    };
    profileRepository.createQueryBuilder.mockReturnValue(
      queryBuilderMock as any,
    );

    await expect(
      service.issueUpdateChallenge(
        'ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi',
        { username: 'taken_name' },
        '127.0.0.1',
        'jest',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects chain_name that is not currently owned by address', async () => {
    mockGetOwnedChainNames.mockResolvedValueOnce(['owned.chain']);

    await expect(
      service.issueUpdateChallenge(
        'ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi',
        { chain_name: 'not-owned.chain' },
        '127.0.0.1',
        'jest',
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
