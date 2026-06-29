import { BadRequestException, UnauthorizedException } from '@nestjs/common';

jest.mock('@/profile/services/profile-signature.util', () => ({
  verifyAeAddressSignature: jest.fn(),
}));

import { verifyAeAddressSignature } from '@/profile/services/profile-signature.util';
import { DeviceChallengeService } from './device-challenge.service';
import { buildRoomMuteMessage } from '@/token-gated-rooms/notifications/room-mute.message';
import { buildPreferencesUpdateMessage } from '../notifications.constants';

const verifyMock = verifyAeAddressSignature as jest.Mock;

const ADDR = 'ak_alice';
const SALE = 'ct_sale';

/**
 * Task 13 — the additive `verifyAndConsumeForRoomMute` on the SHARED challenge
 * service. Mirrors the preferences-intent tests: same nonce table, distinct
 * body-bound message, single-use consume.
 */
describe('DeviceChallengeService.verifyAndConsumeForRoomMute', () => {
  let repo: any;
  let service: DeviceChallengeService;
  const config = {
    challengeTtlMs: 300_000,
    challengeMaxPendingPerAddress: 5,
  } as any;

  const validChallenge = () => ({
    nonce: 'n1',
    address: ADDR,
    consumed_at: null,
    expires_at: new Date(Date.now() + 60_000),
  });

  beforeEach(() => {
    verifyMock.mockReset();
    repo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    service = new DeviceChallengeService(repo, config);
  });

  it('verifies against the body-bound room-mute message', async () => {
    repo.findOne.mockResolvedValue(validChallenge());
    verifyMock.mockReturnValue(true);
    await service.verifyAndConsumeForRoomMute(
      'n1',
      ADDR,
      SALE,
      true,
      false,
      'sg_ok',
    );
    expect(verifyMock).toHaveBeenCalledWith(
      ADDR,
      buildRoomMuteMessage(ADDR, 'n1', SALE, true, false),
      'sg_ok',
    );
  });

  it('consumes the nonce atomically on success (single-use)', async () => {
    repo.findOne.mockResolvedValue(validChallenge());
    verifyMock.mockReturnValue(true);
    await service.verifyAndConsumeForRoomMute(
      'n1',
      ADDR,
      SALE,
      true,
      undefined,
      'sg_ok',
    );
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 'n1' }),
      expect.objectContaining({ consumed_at: expect.any(Date) }),
    );
  });

  it('rejects when the nonce was already used', async () => {
    repo.findOne.mockResolvedValue({
      ...validChallenge(),
      consumed_at: new Date(),
    });
    await expect(
      service.verifyAndConsumeForRoomMute(
        'n1',
        ADDR,
        SALE,
        true,
        false,
        'sg_ok',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a swapped body (sig for muted=true replayed as muted=false)', async () => {
    repo.findOne.mockResolvedValue(validChallenge());
    // The verifier is fed buildRoomMuteMessage(..., muted=false); a sig captured
    // for muted=true does not match → false.
    verifyMock.mockReturnValue(false);
    await expect(
      service.verifyAndConsumeForRoomMute(
        'n1',
        ADDR,
        SALE,
        false,
        false,
        'sg_for_muted_true',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verifyMock).toHaveBeenCalledWith(
      ADDR,
      buildRoomMuteMessage(ADDR, 'n1', SALE, false, false),
      'sg_for_muted_true',
    );
  });

  it('a preferences-intent message differs from the room-mute message (no cross-replay)', () => {
    const roomMsg = buildRoomMuteMessage(ADDR, 'n1', SALE, true, false);
    const prefMsg = buildPreferencesUpdateMessage(ADDR, 'n1', [
      { type: 'room-messages', enabled: false },
    ]);
    expect(roomMsg).not.toBe(prefMsg);
  });
});
