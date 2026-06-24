import {
  BadRequestException,
  GoneException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';

jest.mock('@/profile/services/profile-signature.util', () => ({
  verifyAeAddressSignature: jest.fn(),
}));

import { verifyAeAddressSignature } from '@/profile/services/profile-signature.util';
import { DeviceChallengeService } from './device-challenge.service';
import {
  buildDeviceLinkMessage,
  buildDeviceUnlinkMessage,
  buildFeedSessionMessage,
  buildPreferencesUpdateMessage,
} from '../notifications.constants';

const verifyMock = verifyAeAddressSignature as jest.Mock;
const TOKEN = 'ExponentPushToken[abc]';

describe('DeviceChallengeService', () => {
  let repo: any;
  let service: DeviceChallengeService;
  const config = {
    challengeTtlMs: 300_000,
    challengeMaxPendingPerAddress: 5,
  } as any;

  beforeEach(() => {
    verifyMock.mockReset();
    repo = {
      save: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      })),
    };
    service = new DeviceChallengeService(repo, config);
  });

  it('issues a challenge with just nonce + expiry (no canonical message)', async () => {
    const res = await service.issue('ak_alice');
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'ak_alice', consumed_at: null }),
    );
    expect(res.nonce).toBeDefined();
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect((res as any).message).toBeUndefined();
  });

  it('throws 429 when pending challenges exceed the per-address cap', async () => {
    repo.count.mockResolvedValue(5);
    await expect(service.issue('ak_alice')).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  const validChallenge = () => ({
    nonce: 'n1',
    address: 'ak_alice',
    consumed_at: null,
    expires_at: new Date(Date.now() + 60_000),
  });

  it('rejects a missing or address-mismatched challenge', async () => {
    repo.findOne.mockResolvedValue(undefined);
    await expect(
      service.verifyAndConsume('n1', 'ak_alice', TOKEN, 'sg_x'),
    ).rejects.toBeInstanceOf(BadRequestException);

    repo.findOne.mockResolvedValue({ ...validChallenge(), address: 'ak_bob' });
    await expect(
      service.verifyAndConsume('n1', 'ak_alice', TOKEN, 'sg_x'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an already-consumed challenge', async () => {
    repo.findOne.mockResolvedValue({
      ...validChallenge(),
      consumed_at: new Date(),
    });
    await expect(
      service.verifyAndConsume('n1', 'ak_alice', TOKEN, 'sg_x'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an expired challenge', async () => {
    repo.findOne.mockResolvedValue({
      ...validChallenge(),
      expires_at: new Date(Date.now() - 1000),
    });
    await expect(
      service.verifyAndConsume('n1', 'ak_alice', TOKEN, 'sg_x'),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('rejects an invalid signature against the token-bound link message', async () => {
    repo.findOne.mockResolvedValue(validChallenge());
    verifyMock.mockReturnValue(false);
    await expect(
      service.verifyAndConsume('n1', 'ak_alice', TOKEN, 'sg_bad'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verifyMock).toHaveBeenCalledWith(
      'ak_alice',
      buildDeviceLinkMessage('ak_alice', TOKEN, 'n1'),
      'sg_bad',
    );
  });

  it('rejects a signature for a DIFFERENT token (cross-token replay)', async () => {
    repo.findOne.mockResolvedValue(validChallenge());
    // Mock: verifier returns true only for the *attacker* token; the call we
    // make uses the *victim* token, so the verifier sees a different message
    // and returns false — simulated here directly.
    verifyMock.mockReturnValue(false);
    await expect(
      service.verifyAndConsume(
        'n1',
        'ak_alice',
        'ExponentPushToken[victim]',
        'sg_for_attacker_token',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('consumes the challenge atomically on success', async () => {
    repo.findOne.mockResolvedValue(validChallenge());
    verifyMock.mockReturnValue(true);
    await service.verifyAndConsume('n1', 'ak_alice', TOKEN, 'sg_ok');
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 'n1' }),
      expect.objectContaining({ consumed_at: expect.any(Date) }),
    );
  });

  it('rejects when the atomic consume affects no rows (race lost)', async () => {
    repo.findOne.mockResolvedValue(validChallenge());
    verifyMock.mockReturnValue(true);
    repo.update.mockResolvedValue({ affected: 0 });
    await expect(
      service.verifyAndConsume('n1', 'ak_alice', TOKEN, 'sg_ok'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('verifyAndConsumeForUnlink uses the unlink message', async () => {
    repo.findOne.mockResolvedValue(validChallenge());
    verifyMock.mockReturnValue(true);
    await service.verifyAndConsumeForUnlink('n1', 'ak_alice', TOKEN, 'sg_ok');
    expect(verifyMock).toHaveBeenCalledWith(
      'ak_alice',
      buildDeviceUnlinkMessage('ak_alice', TOKEN, 'n1'),
      'sg_ok',
    );
  });

  it('verifyAndConsumeForPreferences binds the body hash', async () => {
    repo.findOne.mockResolvedValue(validChallenge());
    verifyMock.mockReturnValue(true);
    const prefs = [
      { type: 'announcement', enabled: false },
      { type: 'incoming-transfer', enabled: true },
    ];
    await service.verifyAndConsumeForPreferences(
      'n1',
      'ak_alice',
      prefs,
      'sg_ok',
    );
    expect(verifyMock).toHaveBeenCalledWith(
      'ak_alice',
      buildPreferencesUpdateMessage('ak_alice', 'n1', prefs),
      'sg_ok',
    );
  });

  it('verifyAndConsumeForSession verifies the feed-session message and consumes', async () => {
    repo.findOne.mockResolvedValue(validChallenge());
    verifyMock.mockReturnValue(true);
    await service.verifyAndConsumeForSession('n1', 'ak_alice', 'sg_ok');
    expect(verifyMock).toHaveBeenCalledWith(
      'ak_alice',
      buildFeedSessionMessage('ak_alice', 'n1'),
      'sg_ok',
    );
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 'n1' }),
      expect.objectContaining({ consumed_at: expect.any(Date) }),
    );
  });

  it('verifyAndConsumeForSession rejects an invalid signature', async () => {
    repo.findOne.mockResolvedValue(validChallenge());
    verifyMock.mockReturnValue(false);
    await expect(
      service.verifyAndConsumeForSession('n1', 'ak_alice', 'sg_bad'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects a preferences signature replayed against a mutated body', async () => {
    repo.findOne.mockResolvedValue(validChallenge());
    // First, the legit call would succeed with the legit body:
    verifyMock.mockReturnValue(false); // simulate verifier seeing the wrong message
    const swapped = [{ type: 'announcement', enabled: true }];
    await expect(
      service.verifyAndConsumeForPreferences(
        'n1',
        'ak_alice',
        swapped,
        'sg_for_a_different_body',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
